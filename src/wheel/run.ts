import { readFileSync, unlinkSync } from "node:fs";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { RpcProvider } from "starknet";
import { config } from "../config.ts";
import { escapeHtml } from "../lib/format.ts";
import { eliUrls } from "../bot/eli-card.ts";
import {
  insertWheelSpin,
  updateWheelSpin,
  type WheelSpinRow,
} from "../store/db.ts";
import { getCachedEliHolders, refreshEliHolders } from "./holders.ts";
import { eliNftLabel, rollWheelOutcome, type RollWheelOptions } from "./outcome.ts";
import { notifyWheelOwners, wheelFailureOwnerHtml } from "./notify.ts";
import { payoutCaptionNote, settleWheelPayout } from "./payout.ts";
import { renderWheelVideo } from "./render.ts";
import { resolveCompositionId, type WheelVariantKey } from "./variants.ts";

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spoilerCaption(): string {
  return [
    "✨ <b>Eli Selects</b>",
    "",
    "Eli is picking today's $SLAY winner…",
    "<i>Result reveals when the reel stops.</i>",
  ].join("\n");
}

export function resultCaption(spin: WheelSpinRow, payoutNote: string): string {
  if (!spin.hasWinner || spin.tokenId == null) {
    return [
      "✨ <b>Eli Selects</b>",
      "",
      "Result: <b>No winner</b> today.",
      "Come back for the next draw.",
      "",
      payoutNote,
    ].join("\n");
  }

  const urls = eliUrls(spin.tokenId);
  const label = eliNftLabel(spin.tokenId);
  return [
    "✨ <b>Eli Selects</b>",
    "",
    `Winner: <b>${escapeHtml(label)}</b>`,
    `Prize: <b>${spin.prizeSlay} SLAY</b>`,
    `Owner: <code>${escapeHtml(spin.ownerAddress ?? "")}</code>`,
    `<a href="${urls.marketplace}">View ${escapeHtml(label)}</a>`,
    "",
    payoutNote,
  ].join("\n");
}

export interface RunWheelSpinOptions extends RollWheelOptions {
  /** Chats that receive the same draw (one winner, one payout). */
  chatIds: number[];
  variantKey?: WheelVariantKey;
  /** Prep/status lines (keep for manual test; off for scheduled/production). */
  showStatus?: boolean;
}

/**
 * One global spin: holders → roll → render once → post to every chat → edit → pin → pay.
 */
export async function runWheelSpin(
  bot: Bot,
  provider: RpcProvider,
  chatIdOrOpts: number | RunWheelSpinOptions,
  variantKeyLegacy: WheelVariantKey = "reel",
): Promise<{ ok: true; spinId: number } | { ok: false; error: string }> {
  const opts: RunWheelSpinOptions =
    typeof chatIdOrOpts === "number"
      ? { chatIds: [chatIdOrOpts], variantKey: variantKeyLegacy, showStatus: true }
      : chatIdOrOpts;

  const chatIds = [...new Set(opts.chatIds.filter((id) => Number.isSafeInteger(id) && id !== 0))];
  if (!chatIds.length) return { ok: false, error: "no_chats" };

  const primaryChatId = chatIds[0]!;
  const showStatus = opts.showStatus !== false;
  const { variant, compositionId } = resolveCompositionId(opts.variantKey ?? "reel");

  let statusMsgId: number | null = null;
  if (showStatus) {
    const statusMsg = await bot.api.sendMessage(
      primaryChatId,
      `🎰 Preparing <b>${variant}</b> spin (holders + animation)…`,
      { parse_mode: "HTML" },
    );
    statusMsgId = statusMsg.message_id;
  }

  try {
    let holders = getCachedEliHolders();
    if (holders.length < 100) {
      holders = await refreshEliHolders(provider);
    }
    if (!holders.length) {
      if (statusMsgId != null) {
        await bot.api.editMessageText(
          primaryChatId,
          statusMsgId,
          "❌ No Eli holders found on-chain (and no cache). Cannot spin.",
        );
      }
      return { ok: false, error: "no_holders" };
    }

    const outcome = rollWheelOutcome(holders, {
      forceWin: opts.forceWin,
      dropSmallestPrize: opts.dropSmallestPrize,
    });
    let spin = insertWheelSpin({
      hasWinner: outcome.hasWinner,
      tokenId: outcome.tokenId,
      ownerAddress: outcome.ownerAddress,
      prizeSlay: outcome.prizeSlay,
      status: "pending_render",
    });

    if (showStatus && statusMsgId != null) {
      await bot.api.editMessageText(
        primaryChatId,
        statusMsgId,
        `🎰 Rendering <b>${variant}</b> (${compositionId})…`,
        { parse_mode: "HTML" },
      );
    }

    const videoPath = await renderWheelVideo(outcome, compositionId);
    spin =
      updateWheelSpin(spin.id, {
        videoPath,
        status: videoPath ? "ready" : "ready",
      }) ?? spin;

    if (statusMsgId != null) {
      try {
        await bot.api.deleteMessage(primaryChatId, statusMsgId);
      } catch {
        // ignore
      }
      statusMsgId = null;
    }

    let videoBytes: Buffer | null = null;
    if (videoPath) {
      try {
        videoBytes = readFileSync(videoPath);
      } catch (error) {
        console.warn("Wheel video read failed:", error);
      } finally {
        try {
          unlinkSync(videoPath);
        } catch {
          // ignore
        }
      }
    }

    const posted: { chatId: number; messageId: number }[] = [];
    for (const chatId of chatIds) {
      let messageId: number | null = null;
      if (videoBytes) {
        try {
          const sent = await bot.api.sendVideo(
            chatId,
            new InputFile(videoBytes, "wheel.mp4"),
            {
              caption: spoilerCaption(),
              parse_mode: "HTML",
              supports_streaming: true,
            },
          );
          messageId = sent.message_id;
        } catch (error) {
          console.warn(`Wheel video send failed for ${chatId}:`, error);
        }
      }
      if (messageId == null) {
        try {
          const sent = await bot.api.sendMessage(chatId, spoilerCaption(), {
            parse_mode: "HTML",
          });
          messageId = sent.message_id;
        } catch (error) {
          console.warn(`Wheel text send failed for ${chatId}:`, error);
          continue;
        }
      }
      posted.push({ chatId, messageId });
    }

    if (!posted.length) {
      return { ok: false, error: "post_failed" };
    }

    const primary = posted[0]!;
    spin =
      updateWheelSpin(spin.id, {
        chatId: primary.chatId,
        messageId: primary.messageId,
        status: "posted",
        videoPath: null,
      }) ?? spin;

    // Wait through spin + winner hold before editing the caption (reel is ~11s).
    await pause(videoBytes ? 11_000 : 1_500);

    let payoutNote: string;
    if (!spin.hasWinner || !spin.ownerAddress || spin.prizeSlay == null) {
      payoutNote = config.wheelLive ? "" : "<i>Dry-run mode - no transfer.</i>";
    } else {
      const settled = await settleWheelPayout(provider, spin.id);
      payoutNote = payoutCaptionNote(settled);
      if ("spin" in settled) spin = settled.spin;
      if (settled.kind === "failed") {
        await notifyWheelOwners(
          bot,
          wheelFailureOwnerHtml({
            spinId: spin.id,
            error: settled.error,
            prizeSlay: spin.prizeSlay,
            tokenId: spin.tokenId,
          }),
        );
      }
    }

    const caption = resultCaption(spin, payoutNote);
    for (const { chatId, messageId } of posted) {
      try {
        await bot.api.editMessageCaption(chatId, messageId, {
          caption,
          parse_mode: "HTML",
        });
      } catch {
        try {
          await bot.api.editMessageText(chatId, messageId, caption, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.sendMessage(chatId, caption, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            });
          } catch {
            // ignore
          }
        }
      }

      try {
        await bot.api.pinChatMessage(chatId, messageId, { disable_notification: true });
      } catch (error) {
        const desc =
          error && typeof error === "object" && "description" in error
            ? String((error as { description?: string }).description ?? "")
            : "";
        if (/not enough rights|PIN_MESSAGE|CHAT_ADMIN_REQUIRED/i.test(desc)) {
          console.log(`Wheel: skip pin in ${chatId} (no pin rights)`);
        } else {
          console.warn(`Wheel: pin skipped for ${chatId}: ${desc || String(error)}`);
        }
      }
    }

    if (spin.status === "posted") {
      spin = updateWheelSpin(spin.id, { status: "edited" }) ?? spin;
    }
    if (spin.status === "edited" || spin.status === "posted") {
      updateWheelSpin(spin.id, { status: "pinned" });
    }

    return { ok: true, spinId: spin.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("Wheel spin failed:", error);
    if (statusMsgId != null) {
      try {
        await bot.api.editMessageText(primaryChatId, statusMsgId, `❌ Wheel failed: ${msg}`);
      } catch {
        await bot.api.sendMessage(primaryChatId, `❌ Wheel failed: ${msg}`);
      }
    } else {
      try {
        await bot.api.sendMessage(primaryChatId, `❌ Wheel failed: ${msg}`);
      } catch {
        // ignore
      }
    }
    return { ok: false, error: msg };
  }
}
