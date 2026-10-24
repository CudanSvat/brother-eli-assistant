import type { Bot } from "grammy";
import { GrammyError, InlineKeyboard } from "grammy";
import { escapeHtml } from "../lib/format.ts";
import { formatBurnAmount, rawToUnits } from "../market/burn.ts";
import { launchpadTokenUrl } from "../market/launchpad.ts";
import { deleteGroup, tokensByAddress } from "../store/db.ts";
import type { BurnDigestEvent } from "../indexer/burn-poller.ts";

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

function digestCaption(event: BurnDigestEvent): string {
  const { watch, amountRaw, burnCount, totalBurnedRaw } = event;
  const amount = formatBurnAmount(rawToUnits(amountRaw, watch.decimals));
  const total = formatBurnAmount(rawToUnits(totalBurnedRaw, watch.decimals));
  const burns =
    burnCount <= 1 ? "1 burn" : `${burnCount.toLocaleString("en-US")} burns`;
  const launchUrl = launchpadTokenUrl(watch.tokenAddress);

  return [
    `🔥 <b>$${escapeHtml(watch.symbol)} burn digest</b>`,
    "",
    `Another <b>${escapeHtml(amount)}</b> ${escapeHtml(watch.symbol)} burned since last check (${escapeHtml(burns)}).`,
    `Total burned: <b>${escapeHtml(total)}</b>`,
    "",
    `<a href="${launchUrl}">Open on launchpad</a>`,
  ].join("\n");
}

/** Post hourly burn digests to every group that tracks the burned token. */
export function attachBurnDispatcher(bot: Bot) {
  const dropped = new Set<number>();

  return async function onBurnDigest(event: BurnDigestEvent): Promise<void> {
    const tokens = tokensByAddress(event.watch.tokenAddress);
    const chatIds = [...new Set(tokens.map((t) => t.chatId))].filter((id) => !dropped.has(id));
    if (!chatIds.length) {
      console.log(
        `Burn digest ${event.watch.symbol} ${formatBurnAmount(rawToUnits(event.amountRaw, event.watch.decimals))} — no tracked chats`,
      );
      return;
    }

    const caption = digestCaption(event);
    const markup = new InlineKeyboard().url("Launchpad", launchpadTokenUrl(event.watch.tokenAddress));

    for (const chatId of chatIds) {
      try {
        await bot.api.sendMessage(chatId, caption, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: markup,
        });
        console.log(
          `Burn digest ${event.watch.symbol} ${formatBurnAmount(rawToUnits(event.amountRaw, event.watch.decimals))} → chat ${chatId}`,
        );
      } catch (error) {
        if (isForbidden(error)) {
          console.warn(`Chat ${chatId} is gone; dropping group for burn digests:`, error);
          dropped.add(chatId);
          deleteGroup(chatId);
          continue;
        }
        console.warn(`Burn digest send failed chat ${chatId}:`, error);
      }
      await pause(350);
    }
  };
}
