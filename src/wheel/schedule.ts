import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { RpcProvider } from "starknet";
import { config } from "../config.ts";
import { getMeta, setMeta } from "../store/db.ts";
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
/** Test-friendly delay; restore to 5–15 min for production launch. */
const LAUNCH_DELAY_MIN_MS = 1 * 60_000;
const LAUNCH_DELAY_MAX_MS = 5 * 60_000;

export const WHEEL_LAUNCH_INTRO = [
  "Brother Eli Selects starts today.",
  "Every day between 17:00 and 21:00 (CET), Brother Eli will (with a 50% chance) pick one Bald King for a chance of 8/88/888/8888 SLAY - are you holding the lucky one?",
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

/** Post intro → wait 1–5 min (test) → forced-win spin (no smallest prize). */
export async function runWheelLaunchSequence(
  bot: Bot,
  provider: RpcProvider,
): Promise<{ ok: true; spinId: number } | { ok: false; error: string }> {
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

    const result = await runWheelSpin(bot, provider, {
      chatIds,
      showStatus: false,
      forceWin: true,
      dropSmallestPrize: true,
    });

    if (result.ok) {
      markWheelLaunchDone();
      const next = pickNextDailyDrawAfter(new Date());
      writeNextAt(next);
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
 * Arms the daily clock (test bot: set WHEEL_DAILY=1).
 * Launch day runs on the first fire (or via /wheel_launch).
 */
export function startWheelScheduler(bot: Bot, provider: RpcProvider): void {
  if (!config.wheelEnabled || !config.wheelDaily) {
    console.log("Wheel scheduler: off (need WHEEL_ENABLED + WHEEL_DAILY)");
    return;
  }
  if (schedulerStarted) return;
  schedulerStarted = true;

  if (!readNextAt()) {
    const next = pickNextDailyDrawAfter(new Date());
    writeNextAt(next);
  }

  const nextAt = readNextAt()!;
  console.log(
    `Wheel scheduler: armed next=${new Date(nextAt).toISOString()} launchDone=${isWheelLaunchDone()}`,
  );

  const tick = async () => {
    try {
      const due = readNextAt();
      if (due == null || Date.now() < due) return;
      // Reserve next slot before running so restarts don't double-fire.
      const following = pickNextDailyDrawAfter(new Date(due + 60_000));
      writeNextAt(following);

      if (!isWheelLaunchDone()) {
        console.log("Wheel scheduler: running launch sequence");
        await runWheelLaunchSequence(bot, provider);
      } else {
        console.log("Wheel scheduler: running daily draw");
        await runScheduledDaily(bot, provider);
      }
    } catch (error) {
      console.warn("Wheel scheduler tick failed:", error);
    }
  };

  void tick();
  setInterval(() => void tick(), 30_000);
}
