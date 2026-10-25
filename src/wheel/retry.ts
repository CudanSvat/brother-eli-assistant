import type { Bot } from "grammy";
import type { RpcProvider } from "starknet";
import { escapeHtml } from "../lib/format.ts";
import { eliUrls } from "../bot/eli-card.ts";
import { getLatestRetryableWheelSpin, getWheelSpin } from "../store/db.ts";
import { notifyWheelOwners, wheelFailureOwnerHtml } from "./notify.ts";
import { payoutCaptionNote, settleWheelPayout } from "./payout.ts";

/**
 * Retry the latest unpaid winning spin in this chat (failed / dry_run / stuck paying).
 * Idempotent — will not double-pay.
 */
export async function retryLatestWheelPayout(
  bot: Bot,
  provider: RpcProvider,
  chatId: number,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const spin = getLatestRetryableWheelSpin(chatId);
  if (!spin) {
    return {
      ok: false,
      text: "No retryable payout. (Nothing failed, or the last win was already paid.)",
    };
  }

  const settled = await settleWheelPayout(provider, spin.id);
  const note = payoutCaptionNote(settled);
  const latest = "spin" in settled ? settled.spin : getWheelSpin(spin.id) ?? spin;

  if (settled.kind === "failed") {
    await notifyWheelOwners(
      bot,
      wheelFailureOwnerHtml({
        spinId: latest.id,
        error: settled.error,
        prizeSlay: latest.prizeSlay,
        tokenId: latest.tokenId,
      }),
    );
  }
  if (settled.kind === "paid" || settled.kind === "already_paid") {
    await notifyWheelOwners(
      bot,
      `<b>Eli Selects — payout ok</b>\nSpin <code>#${latest.id}</code>\n${note}`,
    );
  }

  const head =
    latest.tokenId != null
      ? `Eli Selects retry · spin #${latest.id} · Eli #${latest.tokenId}`
      : `Eli Selects retry · spin #${latest.id}`;

  const urls = latest.tokenId != null ? eliUrls(latest.tokenId) : null;
  const lines = [
    `<b>${escapeHtml(head)}</b>`,
    note,
    urls ? `<a href="${urls.marketplace}">View Eli #${latest.tokenId}</a>` : null,
  ].filter(Boolean);

  const text = lines.join("\n");

  if (latest.messageId != null && latest.chatId != null) {
    const caption = [
      "✨ <b>Eli Selects</b>",
      "",
      latest.tokenId != null ? `Winner: <b>Eli #${latest.tokenId}</b>` : "Winner",
      `Prize: <b>${latest.prizeSlay} SLAY</b>`,
      latest.ownerAddress ? `Owner: <code>${escapeHtml(latest.ownerAddress)}</code>` : null,
      urls ? `<a href="${urls.marketplace}">View Eli #${latest.tokenId}</a>` : null,
      "",
      note,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await bot.api.editMessageCaption(latest.chatId, latest.messageId, {
        caption,
        parse_mode: "HTML",
      });
    } catch {
      try {
        await bot.api.editMessageText(latest.chatId, latest.messageId, caption, {
          parse_mode: "HTML",
        });
      } catch {
        // fall through to reply text
      }
    }
  }

  return { ok: settled.kind === "paid" || settled.kind === "already_paid", text };
}
