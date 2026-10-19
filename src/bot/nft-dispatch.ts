import type { Bot } from "grammy";
import { GrammyError, InputFile } from "grammy";
import {
  deleteGroup,
  listNftAlertChatIds,
  markPosted,
  wasPosted,
} from "../store/db.ts";
import type { NftAlertEvent } from "../indexer/nft-activity.ts";
import { eliCaption, eliKeyboard, eliUrls, fetchEliMetadata, fetchEliRarity } from "./eli-card.ts";
import { renderEliWithRarityBadge } from "./eli-art.ts";

function headlineFor(event: NftAlertEvent): string {
  const price = event.priceLabel ? ` · ${event.priceLabel}` : "";
  switch (event.kind) {
    case "listed":
      return `LISTED${price}`;
    case "auction_listed":
      return `AUCTION LISTED${price}`;
    case "sold":
      return `SOLD${price}`;
    case "auction_sold":
      return `AUCTION SOLD${price}`;
  }
}

function postKey(chatId: number, event: NftAlertEvent): string {
  return `nft:${chatId}:${event.transactionHash}:${event.eventIndex}:${event.tokenId}:${event.kind}`;
}

function isForbidden(error: unknown): boolean {
  if (error instanceof GrammyError) {
    if (error.error_code === 403) return true;
    return /kicked|blocked|chat not found|bot is not a member|bot was kicked/i.test(
      error.description,
    );
  }
  return false;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function attachNftDispatcher(bot: Bot) {
  const dropped = new Set<number>();

  return async function onNftAlert(event: NftAlertEvent): Promise<void> {
    const chatIds = listNftAlertChatIds().filter((id) => !dropped.has(id));
    if (!chatIds.length) return;

    const urls = eliUrls(event.tokenId);
    const [meta, rarity] = await Promise.all([
      fetchEliMetadata(urls.metadata),
      fetchEliRarity(event.tokenId),
    ]);
    if (!meta) {
      console.warn(`NFT alert skip Eli #${event.tokenId}: metadata unavailable`);
      return;
    }

    const caption = eliCaption(event.tokenId, meta, headlineFor(event), rarity);
    const markup = eliKeyboard(urls);
    let badged: Buffer | null = null;
    if (rarity?.tier) {
      try {
        badged = await renderEliWithRarityBadge(urls.image, rarity.tier);
      } catch (error) {
        console.warn("Eli rarity badge composite failed, sending plain image:", error);
      }
    }
    const fileName = `eli-${event.tokenId}.png`;

    for (const chatId of chatIds) {
      const key = postKey(chatId, event);
      if (wasPosted(key)) continue;
      markPosted(key);

      try {
        const photo = badged ? new InputFile(badged, fileName) : urls.image;
        await bot.api.sendPhoto(chatId, photo, {
          caption,
          parse_mode: "HTML",
          reply_markup: markup,
        });
        console.log(
          `NFT ${event.kind} Eli #${event.tokenId} → chat ${chatId} ${event.priceLabel ?? ""}`.trim(),
        );
      } catch (error) {
        if (isForbidden(error)) {
          console.warn(`Chat ${chatId} is gone; dropping group for NFT alerts:`, error);
          dropped.add(chatId);
          deleteGroup(chatId);
          continue;
        }
        console.warn(`NFT alert send failed chat ${chatId}:`, error);
      }
      await pause(350);
    }
  };
}
