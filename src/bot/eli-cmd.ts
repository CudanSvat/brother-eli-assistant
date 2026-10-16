import { Bot } from "grammy";
import {
  ELI_MAX,
  eliCaption,
  eliKeyboard,
  eliUrls,
  fetchEliMetadata,
  fetchEliRarity,
  parseEliId,
} from "./eli-card.ts";

export function registerEliCommand(bot: Bot): void {
  bot.command("eli", async (ctx) => {
    if (!ctx.chat) return;

    const id = parseEliId(ctx.match);
    if (id == null) {
      await ctx.reply(`Usage: /eli <id>\nExample: /eli 233\nIDs are 1–${ELI_MAX}.`);
      return;
    }

    const urls = eliUrls(id);
    const [meta, rarity] = await Promise.all([
      fetchEliMetadata(urls.metadata),
      fetchEliRarity(id),
    ]);
    if (!meta) {
      await ctx.reply(`Eli #${id} not found (unminted or unavailable).`);
      return;
    }

    try {
      // Let Telegram pull the PNG directly — avoids a ~600KB bot download/re-upload.
      await ctx.replyWithPhoto(urls.image, {
        caption: eliCaption(id, meta, null, rarity),
        parse_mode: "HTML",
        reply_markup: eliKeyboard(urls),
      });
    } catch (error) {
      console.warn("Eli photo send failed:", error);
      await ctx.reply(`Could not load Eli #${id} image. Try again in a moment.`);
    }
  });
}
