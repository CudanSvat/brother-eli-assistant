import type { Bot, Context } from "grammy";
import type { RpcProvider } from "starknet";
import {
  WHEEL_PRIZE_WEIGHTS,
  WHEEL_PRIZE_WEIGHTS_PRODUCTION,
  config,
  isBotOwner,
} from "../config.ts";
import { escapeHtml } from "../lib/format.ts";
import { getTipWalletStatus } from "../wheel/payout.ts";
import { retryLatestWheelPayout } from "../wheel/retry.ts";
import { runWheelSpin } from "../wheel/run.ts";
import {
  isWheelLaunchDone,
  runWheelLaunchSequence,
} from "../wheel/schedule.ts";
import { resolveWheelTargetChatIds } from "../wheel/targets.ts";
import { parseWheelVariant } from "../wheel/variants.ts";

let busy = false;

function prizeModeLabel(): string {
  const active = WHEEL_PRIZE_WEIGHTS.map((t) => t.prizeSlay).join("/");
  const prod = WHEEL_PRIZE_WEIGHTS_PRODUCTION.map((t) => t.prizeSlay).join("/");
  if (config.wheelTestPrizes) return `test prizes ${active} (prod ${prod} remembered)`;
  return `production prizes ${active}`;
}

function requireOwner(ctx: Context): boolean {
  return Boolean(ctx.from && isBotOwner(ctx.from.id));
}

/**
 * Wheel wiring. Production: scheduler only + silent owner /wheel_retry.
 * Manual test commands only when WHEEL_MANUAL=1 (not for go-live).
 */
export function registerWheelCommand(bot: Bot, provider: RpcProvider): void {
  if (!config.wheelEnabled) {
    console.log("Wheel: disabled (set WHEEL_ENABLED=1 to enable)");
    return;
  }
  if (!config.botOwnerIds.length) {
    console.warn("Wheel: BOT_OWNER_IDS empty - failure DMs will not work");
  }

  const scope =
    config.wheelTestChatId != null
      ? `chat=${config.wheelTestChatId}`
      : "all writable groups";
  console.log(
    `Wheel: enabled ${scope} live=${config.wheelLive ? "yes" : "dry-run"} daily=${config.wheelDaily ? "on" : "off"} manual=${config.wheelManual ? "on" : "off"} launchDone=${isWheelLaunchDone()} ${prizeModeLabel()} tip=${config.slayTipAccountAddress ? "configured" : "missing"}`,
  );

  // Silent owner recovery only - never advertised in groups /help
  bot.command("wheel_retry", async (ctx) => {
    if (!requireOwner(ctx)) return;
    if (ctx.chat?.type !== "private") return;
    if (busy) {
      await ctx.reply("Busy - try again in a moment.");
      return;
    }
    busy = true;
    try {
      const me = bot.botInfo ?? (await bot.api.getMe());
      const chats = await resolveWheelTargetChatIds(bot.api, me.id);
      const chatId = chats[0] ?? config.wheelTestChatId;
      if (chatId == null) {
        await ctx.reply("No target chats.");
        return;
      }
      const result = await retryLatestWheelPayout(bot, provider, chatId);
      await ctx.reply(result.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } finally {
      busy = false;
    }
  });

  if (!config.wheelManual) {
    console.log("Wheel: manual commands off (production)");
    return;
  }

  bot.command("wheel_wallet", async (ctx) => {
    if (!requireOwner(ctx)) return;
    if (ctx.chat?.type !== "private") return;

    const status = await getTipWalletStatus(provider);
    const lines = [
      "<b>Eli Selects - tip wallet</b>",
      "",
      `Mode: <b>${config.wheelLive ? "LIVE" : "dry-run"}</b>`,
      `Daily: <b>${config.wheelDaily ? "armed" : "off"}</b>`,
      `Launch day: <b>${isWheelLaunchDone() ? "done" : "pending"}</b>`,
      `Prizes: <code>${escapeHtml(prizeModeLabel())}</code>`,
      `Address: ${status.address ? `<code>${escapeHtml(status.address)}</code>` : "-"}`,
      `Configured: <b>${status.configured ? "yes" : "no"}</b>`,
      `SLAY: <b>${status.slayBalance != null ? status.slayBalance.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "-"}</b>`,
      `STRK (gas): <b>${status.strkBalance != null ? status.strkBalance.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "-"}</b>`,
    ];
    if (status.error) lines.push("", `⚠️ ${escapeHtml(status.error)}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("wheel_test", async (ctx) => {
    if (!requireOwner(ctx)) return;
    if (ctx.chat?.type !== "private") return;
    if (busy) {
      await ctx.reply("Busy - a spin is already running.");
      return;
    }
    const me = bot.botInfo ?? (await bot.api.getMe());
    const chats = await resolveWheelTargetChatIds(bot.api, me.id);
    if (!chats.length) {
      await ctx.reply("No target chats.");
      return;
    }
    const parsed = parseWheelVariant(ctx.match?.trim()) ?? "reel";
    busy = true;
    try {
      await ctx.reply(`Starting Eli Selects in ${chats.length} chat(s)…`);
      const result = await runWheelSpin(bot, provider, {
        chatIds: chats,
        variantKey: parsed,
        showStatus: false,
      });
      await ctx.reply(
        result.ok ? `Done (spin #${result.spinId}).` : `Failed: ${result.error}`,
      );
    } finally {
      busy = false;
    }
  });

  bot.command("wheel_launch", async (ctx) => {
    if (!requireOwner(ctx)) return;
    if (ctx.chat?.type !== "private") return;
    if (isWheelLaunchDone()) {
      await ctx.reply("Launch day already done.");
      return;
    }
    if (busy) {
      await ctx.reply("Busy - try again in a moment.");
      return;
    }
    busy = true;
    try {
      // No group-visible status - only this private ack
      await ctx.reply("Launch started (intro + delayed first spin).");
      const result = await runWheelLaunchSequence(bot, provider);
      await ctx.reply(
        result.ok ? `Launch spin done (#${result.spinId}).` : `Launch failed: ${result.error}`,
      );
    } finally {
      busy = false;
    }
  });
}
