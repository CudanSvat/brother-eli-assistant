import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { RpcProvider } from "starknet";
import { config } from "../config.ts";
import { getLatestWheelSpin, getMeta, setMeta } from "../store/db.ts";
import { notifyWheelOwners } from "./notify.ts";
import { runWheelSpin } from "./run.ts";
import { resolveWheelTargetChatIds } from "./targets.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function launchImagePath(): string | null {
  const candidates = [
    path.join(here, "../../assets/eli-selects-launch.jpg"),
    path.join(process.cwd(), "assets/eli-selects-launch.jpg"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const META_LAUNCH_DONE = "wheel_launch_done";
const META_LAUNCH_INTRO_SENT = "wheel_launch_intro_sent";
const META_LAUNCH_SPIN_AT = "wheel_launch_spin_at_ms";
const META_NEXT_AT = "wheel_next_at_ms";
const TZ = "Europe/Berlin";
const WINDOW_START_HOUR = 17;
const WINDOW_END_HOUR = 21; // exclusive upper bound for random pick
/** Launch-day gap between announcement and first spin. */
const LAUNCH_DELAY_MIN_MS = 5 * 60_000;
const LAUNCH_DELAY_MAX_MS = 15 * 60_000;

export const WHEEL_LAUNCH_INTRO = [
  "Brother Eli Selects starts today.",
  "Every day between 17:00 and 21:00 (CET), Brother Eli will (with a 50% chance) pick one Bald King for a chance of 8, 88, 888 or 8888 SLAY - are you holding the lucky one?",
  "Today's first select is in a few minutes. For the sake of good will, today the winner will be picked with 100% chance and 8 SLAY prize will be removed from the pot. Good luck.",
].join("\n");

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function berlinParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Convert a Berlin wall-clock time to a UTC Date. */
function berlinWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour - 1, minute, 0);
  for (let i = 0; i < 6; i++) {
    const p = berlinParts(new Date(guess));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const want = Date.UTC(year, month - 1, day, hour, minute, 0);
    guess += want - asUtc;
  }
  return new Date(guess);
}

function addBerlinDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const utc = Date.UTC(year, month - 1, day + days);
  const d = new Date(utc);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Random instant in [17:00, 21:00) Europe/Berlin on the next eligible day. */
export function pickNextDailyDrawAfter(after: Date = new Date()): Date {
  const p = berlinParts(after);
  let dayOffset = 0;
  // If we're already past today's window start, schedule tomorrow
  // (even mid-window: avoid double-firing the same evening after a restart).
  if (p.hour >= WINDOW_START_HOUR) dayOffset = 1;

  for (let i = 0; i < 3; i++) {
    const d = addBerlinDays(p.year, p.month, p.day, dayOffset + i);
    const minuteOfWindow = Math.floor(Math.random() * (WINDOW_END_HOUR - WINDOW_START_HOUR) * 60);
    const hour = WINDOW_START_HOUR + Math.floor(minuteOfWindow / 60);
    const minute = minuteOfWindow % 60;
    const when = berlinWallToUtc(d.year, d.month, d.day, hour, minute);
    if (when.getTime() > after.getTime() + 5_000) return when;
  }
  // Fallback: tomorrow 18:00
  const d = addBerlinDays(p.year, p.month, p.day, 1);
  return berlinWallToUtc(d.year, d.month, d.day, 18, 0);
}

export function isWheelLaunchDone(): boolean {
  return getMeta(META_LAUNCH_DONE) === "1";
}

export function markWheelLaunchDone(): void {
  setMeta(META_LAUNCH_DONE, "1");
}

function readNextAt(): number | null {
  const raw = getMeta(META_NEXT_AT);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function writeNextAt(when: Date): void {
  setMeta(META_NEXT_AT, String(when.getTime()));
}

function ensureFutureNextAt(after: Date = new Date()): Date {
  const existing = readNextAt();
  if (existing != null && existing > after.getTime() + 5_000) {
    return new Date(existing);
  }
  const next = pickNextDailyDrawAfter(after);
  writeNextAt(next);
  return next;
}

function randomLaunchDelayMs(): number {
  return (
    LAUNCH_DELAY_MIN_MS +
    Math.floor(Math.random() * (LAUNCH_DELAY_MAX_MS - LAUNCH_DELAY_MIN_MS + 1))
  );
}

let schedulerStarted = false;
let running = false;

async function targetChats(bot: Bot): Promise<number[]> {
  const me = bot.botInfo ?? (await bot.api.getMe());
  return resolveWheelTargetChatIds(bot.api, me.id);
}

async function postLaunchIntro(bot: Bot, chatIds: number[]): Promise<void> {
  const imagePath = launchImagePath();
  for (const chatId of chatIds) {
    try {
      if (imagePath) {
        await bot.api.sendPhoto(chatId, new InputFile(imagePath, "eli-selects-launch.jpg"), {
          caption: WHEEL_LAUNCH_INTRO,
        });
      } else {
        console.warn("Wheel launch image missing; sending text-only intro");
        await bot.api.sendMessage(chatId, WHEEL_LAUNCH_INTRO);
      }
    } catch (error) {
      console.warn(`Wheel launch intro failed for ${chatId}:`, error);
    }
  }
}

/**
 * If intro already went out and a spin row exists, treat launch as done.
 * Prevents a second launch spin after crash/redeploy mid-sequence.
 */
function recoverCompletedLaunch(): number | null {
  if (isWheelLaunchDone()) return null;
  if (getMeta(META_LAUNCH_INTRO_SENT) !== "1") return null;
  const existing = getLatestWheelSpin();
  if (!existing) return null;
  markWheelLaunchDone();
  ensureFutureNextAt(new Date());
  console.log(
    `Wheel: recovered launch as already done (spin #${existing.id}); next=${new Date(readNextAt()!).toISOString()}`,
  );
  return existing.id;
}

/** Post intro → wait 5–15 min → forced-win spin (no smallest prize). */
export async function runWheelLaunchSequence(
  bot: Bot,
  provider: RpcProvider,
): Promise<{ ok: true; spinId: number } | { ok: false; error: string }> {
  const recovered = recoverCompletedLaunch();
  if (recovered != null) return { ok: true, spinId: recovered };
  if (isWheelLaunchDone()) {
    return { ok: false, error: "launch_already_done" };
  }
  if (running) return { ok: false, error: "busy" };
  running = true;
  try {
    const chatIds = await targetChats(bot);
    if (!chatIds.length) return { ok: false, error: "no_chats" };

    const introAlready = getMeta(META_LAUNCH_INTRO_SENT) === "1";
    let spinAt = Number(getMeta(META_LAUNCH_SPIN_AT) || "");
    if (!Number.isFinite(spinAt) || spinAt <= 0) spinAt = 0;

    if (!introAlready) {
      await postLaunchIntro(bot, chatIds);
      setMeta(META_LAUNCH_INTRO_SENT, "1");
      spinAt = Date.now() + randomLaunchDelayMs();
      setMeta(META_LAUNCH_SPIN_AT, String(spinAt));
      const waitMin = Math.max(1, Math.round((spinAt - Date.now()) / 60_000));
      console.log(`Wheel: launch intro sent; first draw at ${new Date(spinAt).toISOString()}`);
      await notifyWheelOwners(
        bot,
        `<b>Eli Selects - launch day</b>\nIntro posted. First draw in ~${waitMin} min.`,
      );
    } else {
      if (!spinAt) {
        spinAt = Date.now() + randomLaunchDelayMs();
        setMeta(META_LAUNCH_SPIN_AT, String(spinAt));
      }
      console.log(
        `Wheel: intro already sent (skip re-post); first draw at ${new Date(spinAt).toISOString()}`,
      );
    }

    const waitMs = Math.max(0, spinAt - Date.now());
    if (waitMs > 0) await pause(waitMs);

    // Re-check after wait (redeploy/crash may have finished the spin elsewhere)
    const recoveredAfterWait = recoverCompletedLaunch();
    if (recoveredAfterWait != null) return { ok: true, spinId: recoveredAfterWait };
    if (isWheelLaunchDone()) return { ok: false, error: "launch_already_done" };

    const result = await runWheelSpin(bot, provider, {
      chatIds,
      showStatus: false,
      forceWin: true,
      dropSmallestPrize: true,
    });

    if (result.ok) {
      markWheelLaunchDone();
      const next = ensureFutureNextAt(new Date());
      console.log(`Wheel: launch spin #${result.spinId}; next daily ${next.toISOString()}`);
    }
    return result;
  } finally {
    running = false;
  }
}

async function runScheduledDaily(
  bot: Bot,
  provider: RpcProvider,
): Promise<void> {
  if (running) {
    console.warn("Wheel: skip scheduled draw (busy)");
    return;
  }
  running = true;
  try {
    const chatIds = await targetChats(bot);
    if (!chatIds.length) {
      console.warn("Wheel: no target chats for daily draw");
      return;
    }
    const result = await runWheelSpin(bot, provider, {
      chatIds,
      showStatus: false,
    });
    if (result.ok) {
      console.log(`Wheel: daily spin #${result.spinId}`);
    } else {
      console.warn(`Wheel: daily spin failed: ${result.error}`);
      await notifyWheelOwners(
        bot,
        `<b>Eli Selects - daily failed</b>\n<code>${result.error}</code>`,
      );
    }
  } finally {
    running = false;
  }
}

/**
 * Arm clock without sending anything on boot.
 * Redeploy keeps the stored next draw time when it is still in the future.
 */
function armSchedulerClock(): void {
  recoverCompletedLaunch();

  if (isWheelLaunchDone()) {
    const next = ensureFutureNextAt(new Date());
    console.log(
      `Wheel scheduler: armed next=${next.toISOString()} launchDone=true (no boot fire)`,
    );
    return;
  }

  const introSent = getMeta(META_LAUNCH_INTRO_SENT) === "1";
  if (!introSent) {
    // True first go-live only
    writeNextAt(new Date(Date.now() + 30_000));
    console.log(
      `Wheel scheduler: launch pending (fresh); first fire ~30s → ${new Date(readNextAt()!).toISOString()}`,
    );
    return;
  }

  // Intro already posted: resume at stored spin time only (never re-arm +30s)
  const spinAt = Number(getMeta(META_LAUNCH_SPIN_AT) || "");
  if (Number.isFinite(spinAt) && spinAt > Date.now() + 5_000) {
    writeNextAt(new Date(spinAt));
  } else if (Number.isFinite(spinAt) && spinAt > 0) {
    // Spin time passed but launch not marked done - tick may recover via spin row
    writeNextAt(new Date(Date.now() + 5_000));
  } else {
    writeNextAt(new Date(Date.now() + 30_000));
  }
  console.log(
    `Wheel scheduler: launch resume at ${new Date(readNextAt()!).toISOString()} (intro already sent)`,
  );
}

/**
 * Arms the daily clock (WHEEL_ENABLED + WHEEL_DAILY).
 * Boot never posts; it only waits for the stored next time.
 */
export function startWheelScheduler(bot: Bot, provider: RpcProvider): void {
  if (!config.wheelEnabled || !config.wheelDaily) {
    console.log("Wheel scheduler: off (need WHEEL_ENABLED + WHEEL_DAILY)");
    return;
  }
  if (schedulerStarted) return;
  schedulerStarted = true;

  armSchedulerClock();

  const tick = async () => {
    try {
      const due = readNextAt();
      if (due == null || Date.now() < due) return;

      if (!isWheelLaunchDone()) {
        // Do not advance the daily clock until launch finishes.
        console.log("Wheel scheduler: running launch sequence");
        await runWheelLaunchSequence(bot, provider);
        return;
      }

      // Reserve the following slot BEFORE running so a crash/redeploy mid-spin
      // cannot replay this same due time.
      const following = pickNextDailyDrawAfter(new Date(Math.max(due, Date.now()) + 60_000));
      writeNextAt(following);
      console.log(
        `Wheel scheduler: running daily draw; reserved next=${following.toISOString()}`,
      );
      await runScheduledDaily(bot, provider);
    } catch (error) {
      console.warn("Wheel scheduler tick failed:", error);
    }
  };

  void tick();
  setInterval(() => void tick(), 30_000);
}
