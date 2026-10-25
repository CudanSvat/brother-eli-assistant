import { createReadStream, unlinkSync } from "node:fs";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import type { RpcProvider } from "starknet";
import { config } from "../config.ts";
import { escapeHtml, shortAddress } from "../lib/format.ts";
import { eliUrls } from "../bot/eli-card.ts";
import {
  insertWheelSpin,
  updateWheelSpin,
  type WheelSpinRow,
} from "../store/db.ts";
import { getCachedEliHolders, refreshEliHolders } from "./holders.ts";
import { rollWheelOutcome } from "./outcome.ts";
import { sendSlayPrize } from "./payout.ts";
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

function resultCaption(spin: WheelSpinRow, payoutNote: string): string {
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
  const owner = spin.ownerAddress ? shortAddress(spin.ownerAddress) : "—";
  return [
    "✨ <b>Eli Selects</b>",
    "",
    `Winner: <b>Eli #${spin.tokenId}</b>`,
    `Prize: <b>${spin.prizeSlay} SLAY</b>`,
    `Owner: <code>${escapeHtml(spin.ownerAddress ?? "")}</code> (${escapeHtml(owner)})`,
    `<a href="${urls.marketplace}">View Eli #${spin.tokenId}</a>`,
    "",
    payoutNote,
  ].join("\n");
}

/**
 * Full test spin: holders → roll → pre-render variant → post → edit → pin → dry-run/live pay.
 */
export async function runWheelSpin(
  bot: Bot,
  provider: RpcProvider,
  chatId: number,
  variantKey: WheelVariantKey = "reel",
): Promise<{ ok: true; spinId: number } | { ok: false; error: string }> {
  const { variant, compositionId } = resolveCompositionId(variantKey);
  const statusMsg = await bot.api.sendMessage(
    chatId,
    `🎰 Preparing <b>${variant}</b> spin (holders + animation)…`,
    { parse_mode: "HTML" },
  );

  try {
    let holders = getCachedEliHolders();
    if (holders.length < 100) {
      holders = await refreshEliHolders(provider);
    }
    if (!holders.length) {
      await bot.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ No Eli holders found on-chain (and no cache). Cannot spin.",
      );
      return { ok: false, error: "no_holders" };
    }

    const outcome = rollWheelOutcome(holders);
    let spin = insertWheelSpin({
      hasWinner: outcome.hasWinner,
      tokenId: outcome.tokenId,
      ownerAddress: outcome.ownerAddress,
      prizeSlay: outcome.prizeSlay,
      status: "pending_render",
    });

    await bot.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎰 Rendering <b>${variant}</b> (${compositionId})…`,
      { parse_mode: "HTML" },
    );

    const videoPath = await renderWheelVideo(outcome, compositionId);
    spin =
      updateWheelSpin(spin.id, {
        videoPath,
        status: videoPath ? "ready" : "ready",
      }) ?? spin;

    try {
      await bot.api.deleteMessage(chatId, statusMsg.message_id);
    } catch {
      // ignore
    }

    let messageId: number | null = null;
    if (videoPath) {
      try {
        const sent = await bot.api.sendVideo(chatId, new InputFile(createReadStream(videoPath), "wheel.mp4"), {
          caption: spoilerCaption(),
          parse_mode: "HTML",
          supports_streaming: true,
        });
        messageId = sent.message_id;
      } catch (error) {
        console.warn("Wheel video send failed:", error);
      } finally {
        try {
          unlinkSync(videoPath);
        } catch {
          // ignore
        }
      }
    }

    if (messageId == null) {
      const sent = await bot.api.sendMessage(chatId, spoilerCaption(), { parse_mode: "HTML" });
      messageId = sent.message_id;
    }

    spin =
      updateWheelSpin(spin.id, {
        chatId,
        messageId,
        status: "posted",
        videoPath: null,
      }) ?? spin;

    // Wait through spin + winner hold before editing the caption (reel is ~11s).
    await pause(videoPath ? 11_000 : 1_500);

    let payoutNote: string;
    if (!spin.hasWinner || !spin.ownerAddress || spin.prizeSlay == null) {
      payoutNote = config.wheelLive ? "" : "<i>Dry-run mode — no transfer.</i>";
    } else if (!config.wheelLive) {
      payoutNote = `<i>Dry-run:</i> would send <b>${spin.prizeSlay} SLAY</b> to <code>${escapeHtml(spin.ownerAddress)}</code>.`;
      spin = updateWheelSpin(spin.id, { status: "dry_run" }) ?? spin;
    } else {
      const pay = await sendSlayPrize(provider, spin.ownerAddress, spin.prizeSlay);
      if (pay.ok) {
        payoutNote = `Paid <b>${spin.prizeSlay} SLAY</b> · <a href="https://starkscan.co/tx/${pay.txHash}">tx</a>`;
        spin = updateWheelSpin(spin.id, { status: "paid", txHash: pay.txHash }) ?? spin;
      } else {
        payoutNote = `Payout failed: ${escapeHtml(pay.error)}`;
        spin = updateWheelSpin(spin.id, { status: "failed", error: pay.error }) ?? spin;
      }
    }

    const caption = resultCaption(spin, payoutNote);
    try {
      await bot.api.editMessageCaption(chatId, messageId, {
        caption,
        parse_mode: "HTML",
      });
    } catch {
      try {
        await bot.api.editMessageText(chatId, messageId, caption, { parse_mode: "HTML" });
      } catch {
        await bot.api.sendMessage(chatId, caption, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    }

    if (spin.status === "posted") {
      spin = updateWheelSpin(spin.id, { status: "edited" }) ?? spin;
    }

    try {
      await bot.api.pinChatMessage(chatId, messageId, { disable_notification: true });
      if (spin.status === "edited" || spin.status === "posted") {
        updateWheelSpin(spin.id, { status: "pinned" });
      }
    } catch (error) {
      console.warn("Wheel pin failed (bot needs pin rights):", error);
    }

    return { ok: true, spinId: spin.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("Wheel spin failed:", error);
    try {
      await bot.api.editMessageText(chatId, statusMsg.message_id, `❌ Wheel failed: ${msg}`);
    } catch {
      await bot.api.sendMessage(chatId, `❌ Wheel failed: ${msg}`);
    }
    return { ok: false, error: msg };
  }
}
