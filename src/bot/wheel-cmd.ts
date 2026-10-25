import type { Bot } from "grammy";
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
import { parseWheelVariant, variantHelp } from "../wheel/variants.ts";

let busy = false;

function prizeModeLabel(): string {
  const active = WHEEL_PRIZE_WEIGHTS.map((t) => t.prizeSlay).join("/");
  const prod = WHEEL_PRIZE_WEIGHTS_PRODUCTION.map((t) => t.prizeSlay).join("/");
  if (config.wheelTestPrizes) return `test prizes ${active} (prod ${prod} remembered)`;
  return `production prizes ${active}`;
}

export function registerWheelCommand(bot: Bot, provider: RpcProvider): void {
  if (!config.wheelEnabled) {
    console.log("Wheel: disabled (set WHEEL_ENABLED=1 to enable)");
    return;
  }
  if (config.wheelTestChatId == null) {
    console.warn("Wheel: WHEEL_ENABLED but WHEEL_TEST_CHAT_ID is missing");
    return;
  }

  console.log(
    `Wheel: enabled chat=${config.wheelTestChatId} live=${config.wheelLive ? "yes" : "dry-run"} ${prizeModeLabel()} tip=${config.slayTipAccountAddress ? "configured" : "missing"}`,
  );

  bot.command("wheel_wallet", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    if (!isBotOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    if (ctx.chat.id !== config.wheelTestChatId && ctx.chat.type !== "private") {
      await ctx.reply("Use /wheel_wallet in the test group or in a DM.");
      return;
    }

    const status = await getTipWalletStatus(provider);
    const lines = [
      "<b>Eli Selects — tip wallet</b>",
      "",
      `Mode: <b>${config.wheelLive ? "LIVE" : "dry-run"}</b>`,
      `Prizes: <code>${escapeHtml(prizeModeLabel())}</code>`,
      `Address: ${status.address ? `<code>${escapeHtml(status.address)}</code>` : "—"}`,
      `Configured: <b>${status.configured ? "yes" : "no"}</b>`,
      `SLAY: <b>${status.slayBalance != null ? status.slayBalance.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</b>`,
      `STRK (gas): <b>${status.strkBalance != null ? status.strkBalance.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</b>`,
    ];
    if (status.error) lines.push("", `⚠️ ${escapeHtml(status.error)}`);
    if (!config.wheelLive) {
      lines.push("", "<i>Set WHEEL_LIVE=1 on Railway to send real transfers.</i>");
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("wheel_retry", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    if (!isBotOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    if (ctx.chat.id !== config.wheelTestChatId) {
      await ctx.reply("Retry only in the configured test group.");
      return;
    }
    if (busy) {
      await ctx.reply("A wheel spin is already running.");
      return;
    }
    busy = true;
    try {
      const result = await retryLatestWheelPayout(bot, provider, ctx.chat.id);
      await ctx.reply(result.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } finally {
      busy = false;
    }
  });

  bot.command("wheel_test", async (ctx) => {
    if (!ctx.chat || !ctx.from) return;
    if (!isBotOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    if (ctx.chat.id !== config.wheelTestChatId) {
      await ctx.reply(
        `Wheel test only works in the configured test group (chat ${config.wheelTestChatId}).`,
      );
      return;
    }
    if (busy) {
      await ctx.reply("A wheel spin is already running.");
      return;
    }

    const parsed = parseWheelVariant(ctx.match?.trim());
    if (parsed == null) {
      await ctx.reply(variantHelp());
      return;
    }

    busy = true;
    try {
      await runWheelSpin(bot, provider, ctx.chat.id, parsed);
    } finally {
      busy = false;
    }
  });
}
