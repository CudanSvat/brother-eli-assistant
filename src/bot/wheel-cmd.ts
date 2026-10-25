import type { Bot } from "grammy";
import type { RpcProvider } from "starknet";
import { config, isBotOwner } from "../config.ts";
import { runWheelSpin } from "../wheel/run.ts";
import { parseWheelVariant, variantHelp } from "../wheel/variants.ts";

let busy = false;

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
    `Wheel: enabled for chat ${config.wheelTestChatId} (live=${config.wheelLive ? "yes" : "dry-run"})`,
  );

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
