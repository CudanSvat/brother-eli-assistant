import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { loadShillImage, renderShillCardPng } from "../chart/shill-card.ts";
import {
  escapeHtml,
  formatPct,
  formatTokenPrice,
  formatUsd,
  normalizeAddress,
} from "../lib/format.ts";
import { avnuSwapUrl, ekuboSwapUrl } from "../market/ekubo.ts";
import {
  launchpadTokenUrl,
  resolveLaunchpadForTracked,
  type LaunchpadToken,
} from "../market/launchpad.ts";
import { getDmSession, getToken, listTokens } from "../store/db.ts";
import type { TokenSettings } from "../types.ts";

function resolveGroupId(ctx: Context): number | null {
  if (!ctx.chat) return null;
  if (ctx.chat.type !== "private") return ctx.chat.id;
  if (!ctx.from) return null;
  return getDmSession(ctx.from.id);
}

function canUseToken(ctx: Context, token: TokenSettings): boolean {
  if (!ctx.chat) return false;
  if (ctx.chat.type === "private") {
    return Boolean(ctx.from && getDmSession(ctx.from.id) === token.chatId);
  }
  return token.chatId === ctx.chat.id;
}

function pickToken(tokens: TokenSettings[], query?: string): TokenSettings | null {
  if (!tokens.length) return null;
  if (!query) return tokens.length === 1 ? tokens[0]! : null;
  const q = query.trim().toLowerCase().replace(/^\$/, "");
  return (
    tokens.find((t) => t.symbol.toLowerCase() === q) ??
    tokens.find((t) => t.name.toLowerCase() === q) ??
    tokens.find((t) => t.symbol.toLowerCase().startsWith(q)) ??
    tokens.find((t) => t.name.toLowerCase().includes(q)) ??
    tokens.find((t) => t.address.toLowerCase().includes(q.replace(/^0x/, ""))) ??
    null
  );
}

function tokenPickerKeyboard(tokens: TokenSettings[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  tokens.forEach((t, i) => {
    kb.text(t.symbol, `sh:${t.id}`);
    if (i % 3 === 2) kb.row();
  });
  return kb;
}

function shillKeyboard(coin: LaunchpadToken): InlineKeyboard {
  const addr = coin.address;
  return new InlineKeyboard()
    .url("Launchpad", launchpadTokenUrl(addr))
    .url("Ekubo", ekuboSwapUrl(addr))
    .row()
    .url("AVNU", avnuSwapUrl(addr, coin.symbol));
}

async function buildShill(token: TokenSettings): Promise<
  | { ok: true; png: Buffer; caption: string; coin: LaunchpadToken }
  | { ok: false; reason: "not_on_launchpad" | "build_failed" }
> {
  const coin = await resolveLaunchpadForTracked(token);
  if (!coin) return { ok: false, reason: "not_on_launchpad" };

  try {
    const image = await loadShillImage(coin.logo);
    const png = await renderShillCardPng({
      symbol: coin.symbol,
      name: coin.name,
      address: coin.address,
      image,
      priceUsd: coin.priceUsd,
      marketCap: coin.marketCap,
      volumeUsd: coin.volumeUsd,
      change24h: coin.change24h,
      holders: coin.holders,
    });

    const launchUrl = launchpadTokenUrl(coin.address);
    const ca = normalizeAddress(coin.address);
    const move = formatPct(coin.change24h);
    const hasHolders = coin.holders != null && Number.isFinite(coin.holders) && coin.holders > 0;
    const metaLine = [
      hasHolders ? `Holders ${Math.round(coin.holders!).toLocaleString("en-US")}` : null,
      `Vol ${formatUsd(coin.volumeUsd)}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const caption = [
      `<b>$${escapeHtml(coin.symbol)}</b> · ${escapeHtml(coin.name)}`,
      `CA: <code>${escapeHtml(ca)}</code>`,
      "",
      `MC ${formatUsd(coin.marketCap)} · Price ${formatTokenPrice(coin.priceUsd)}${move ? ` · 24h ${move}` : ""}`,
      metaLine,
      "",
      `<a href="${launchUrl}">Open on launchpad</a>`,
    ].join("\n");

    return { ok: true, png, caption, coin };
  } catch (error) {
    console.warn("Shill build failed:", error);
    return { ok: false, reason: "build_failed" };
  }
}

async function sendShill(ctx: Context, token: TokenSettings): Promise<void> {
  const built = await buildShill(token);

  if (!built.ok) {
    const msg =
      built.reason === "not_on_launchpad"
        ? `<b>${escapeHtml(token.symbol)}</b> isn’t on the Brother Eli launchpad.\n/shill only works for launchpad coins.`
        : `Could not build a shill card for <b>${escapeHtml(token.symbol)}</b>.`;
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCallbackQuery({
          text:
            built.reason === "not_on_launchpad"
              ? "Not on the launchpad"
              : "Could not build shill card",
          show_alert: true,
        });
      } catch {
        // expired
      }
      if (built.reason === "not_on_launchpad") {
        await ctx.reply(msg, { parse_mode: "HTML" });
      }
      return;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  try {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  } catch {
    // ignore
  }

  if (ctx.callbackQuery?.message && !ctx.callbackQuery.message.photo) {
    try {
      await ctx.deleteMessage();
    } catch {
      // too old
    }
  }

  await ctx.replyWithPhoto(new InputFile(built.png, "shill.png"), {
    caption: built.caption,
    parse_mode: "HTML",
    reply_markup: shillKeyboard(built.coin),
  });
}

export function registerShillCommand(bot: Bot): void {
  bot.command("shill", async (ctx) => {
    if (!ctx.chat) return;
    const groupId = resolveGroupId(ctx);
    if (!groupId) {
      await ctx.reply(
        ctx.chat.type === "private"
          ? "Connect a group first (/start → paste group ID), then /shill."
          : "No group context.",
      );
      return;
    }

    const tokens = listTokens(groupId);
    if (!tokens.length) {
      await ctx.reply("No tokens tracked here yet. Use /start to add one.");
      return;
    }

    const arg = ctx.match?.trim() || "";
    const token = pickToken(tokens, arg || undefined);
    if (!token) {
      await ctx.reply("Which token should we shill?", {
        reply_markup: tokenPickerKeyboard(tokens),
      });
      return;
    }

    await sendShill(ctx, token);
  });

  bot.callbackQuery(/^sh:(\d+)$/, async (ctx) => {
    const tokenId = Number(ctx.match![1]);
    const token = getToken(tokenId);
    if (!token || !canUseToken(ctx, token)) {
      await ctx.answerCallbackQuery({ text: "Token not available here" });
      return;
    }

    try {
      await ctx.answerCallbackQuery({ text: `Shilling ${token.symbol}…` });
    } catch {
      // expired
    }

    await sendShill(ctx, token);
  });
}
