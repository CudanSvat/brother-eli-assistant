import type { Bot } from "grammy";
import { config } from "../config.ts";
import { escapeHtml } from "../lib/format.ts";

/** Silent owner-only DMs for Eli Selects ops (failures, retries). */
export async function notifyWheelOwners(bot: Bot, html: string): Promise<void> {
  const ids = config.botOwnerIds;
  if (!ids.length) {
    console.warn("Wheel owner notify skipped: BOT_OWNER_IDS empty");
    return;
  }
  for (const userId of ids) {
    try {
      await bot.api.sendMessage(userId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      console.warn(`Wheel owner DM failed for ${userId}:`, error);
    }
  }
}

export function wheelFailureOwnerHtml(opts: {
  spinId: number;
  error: string;
  prizeSlay: number | null;
  tokenId: number | null;
}): string {
  return [
    "<b>Eli Selects — payout failed</b>",
    `Spin <code>#${opts.spinId}</code>`,
    opts.tokenId != null ? `Eli #${opts.tokenId}` : null,
    opts.prizeSlay != null ? `Prize: ${opts.prizeSlay} SLAY` : null,
    `Error: ${escapeHtml(opts.error)}`,
    "",
    "After you fix gas/bug, DM me <code>/wheel_retry</code>.",
  ]
    .filter(Boolean)
    .join("\n");
}
