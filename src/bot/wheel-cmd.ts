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
import { parseWheelVariant } from "../wheel/variants.ts";

let busy = false;

function prizeModeLabel(): string {
  const active = WHEEL_PRIZE_WEIGHTS.map((t) => t.prizeSlay).join("/");
  const prod = WHEEL_PRIZE_WEIGHTS_PRODUCTION.map((t) => t.prizeSlay).join("/");
  if (config.wheelTestPrizes) return `test prizes ${active} (prod ${prod} remembered)`;
  return `production prizes ${active}`;
}

/** Owner-only gate: silent for everyone else (no command leakage). */
function requireOwner(ctx: Context): boolean {
  return Boolean(ctx.from && isBotOwner(ctx.from.id));
}

function targetChatId(ctx: Context): number | null {
  if (!ctx.chat) return null;
  // Owner DM → post/spin in the configured test group
  if (ctx.chat.type === "private") return config.wheelTestChatId;
  if (ctx.chat.id === config.wheelTestChatId) return ctx.chat.id;
  return null;
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
  if (!config.botOwnerIds.length) {
    console.warn("Wheel: BOT_OWNER_IDS empty — owner commands/DMs will not work");
  }

  console.log(
    `Wheel: enabled chat=${config.wheelTestChatId} live=${config.wheelLive ? "yes" : "dry-run"} ${prizeModeLabel()} tip=${config.slayTipAccountAddress ? "configured" : "missing"} (owner-only, not in public help)`,
  );

  bot.command("wheel_wallet", async (ctx) => {
    if (!requireOwner(ctx)) return; // silent
    // Prefer DM; allow in test group for owner only
    if (ctx.chat?.type !== "private" && ctx.chat?.id !== config.wheelTestChatId) return;

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
    if (!requireOwner(ctx)) return;
    const chatId = targetChatId(ctx);
    if (chatId == null) return;
    if (busy) {
      await ctx.reply("Busy — try again in a moment.");
      return;
    }
    busy = true;
    try {
      const result = await retryLatestWheelPayout(bot, provider, chatId);
      await ctx.reply(result.text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } finally {
      busy = false;
    }
  });

  bot.command("wheel_test", async (ctx) => {
    if (!requireOwner(ctx)) return;
    const chatId = targetChatId(ctx);
    if (chatId == null) return;
    if (busy) {
      await ctx.reply("Busy — a spin is already running.");
      return;
    }

    // Default reel; optional arg only for owner (no public usage hint)
    const parsed = parseWheelVariant(ctx.match?.trim()) ?? "reel";

    busy = true;
    try {
      // Prefer triggering from DM so the group never sees /wheel_test
      if (ctx.chat?.type === "private") {
        await ctx.reply(`Starting Eli Selects in test group <code>${chatId}</code>…`, {
          parse_mode: "HTML",
        });
      } else if (ctx.message) {
        try {
          await ctx.deleteMessage();
        } catch {
          // need delete-message rights; ignore
        }
      }
      const result = await runWheelSpin(bot, provider, chatId, parsed);
      if (ctx.chat?.type === "private") {
        await ctx.reply(
          result.ok ? `Done (spin #${result.spinId}).` : `Failed: ${result.error}`,
        );
      }
    } finally {
      busy = false;
    }
  });
}
