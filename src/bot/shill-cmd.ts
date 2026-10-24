import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { RpcProvider } from "starknet";
import { DEGENZ_TOKEN } from "../config.ts";
import { loadShillImage, renderShillCardPng } from "../chart/shill-card.ts";
import {
  addressesEqual,
  escapeHtml,
  formatPct,
  formatTokenPrice,
  formatUsd,
  normalizeAddress,
} from "../lib/format.ts";
import { formatBurnAmount, getBurnedRaw, rawToUnits } from "../market/burn.ts";
import { avnuSwapUrl, ekuboSwapUrl } from "../market/ekubo.ts";
import {
  getLaunchpadTokenByAddress,
  launchpadTokenUrl,
  searchLaunchpadToken,
  type LaunchpadToken,
} from "../market/launchpad.ts";
import { getDmSession } from "../store/db.ts";

let burnProvider: RpcProvider | null = null;

function resolveGroupId(ctx: Context): number | null {
  if (!ctx.chat) return null;
  if (ctx.chat.type !== "private") return ctx.chat.id;
  if (!ctx.from) return null;
  return getDmSession(ctx.from.id);
}

function shillKeyboard(coin: LaunchpadToken): InlineKeyboard {
  const addr = coin.address;
  return new InlineKeyboard()
    .url("Launchpad", launchpadTokenUrl(addr))
    .url("Ekubo", ekuboSwapUrl(addr))
    .row()
    .url("AVNU", avnuSwapUrl(addr, coin.symbol, "strk"));
}

function argLooksLikeDegenz(arg: string): boolean {
  const q = arg.trim().toLowerCase().replace(/^\$/, "");
  if (!q) return true; // bare /shill → DEGENZ
  if (q === "degenz" || q === "starknet degenz") return true;
  if (/^0x[0-9a-f]+$/i.test(q) && addressesEqual(q, DEGENZ_TOKEN)) return true;
  return false;
}

async function loadDegenz(): Promise<LaunchpadToken | null> {
  return (
    (await getLaunchpadTokenByAddress(DEGENZ_TOKEN)) ?? (await searchLaunchpadToken("DEGENZ"))
  );
}

async function buildDegenzShill(): Promise<
  | { ok: true; png: Buffer; caption: string; coin: LaunchpadToken }
  | { ok: false; reason: "not_found" | "build_failed" }
> {
  const coin = await loadDegenz();
  if (!coin) return { ok: false, reason: "not_found" };

  try {
    const burnedRaw = burnProvider ? await getBurnedRaw(burnProvider, coin.address) : 0n;
    const burnedUnits = rawToUnits(burnedRaw, 18);
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
      burned: burnedUnits > 0 ? burnedUnits : null,
    });

    const launchUrl = launchpadTokenUrl(coin.address);
    const ca = normalizeAddress(coin.address);
    const move = formatPct(coin.change24h);
    const hasHolders = coin.holders != null && Number.isFinite(coin.holders) && coin.holders > 0;
    const metaLine = [
      hasHolders ? `Holders ${Math.round(coin.holders!).toLocaleString("en-US")}` : null,
      burnedUnits > 0 ? `Burned ${formatBurnAmount(burnedUnits)}` : null,
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

async function sendDegenzShill(ctx: Context): Promise<void> {
  const built = await buildDegenzShill();

  if (!built.ok) {
    const msg =
      built.reason === "not_found"
        ? "Couldn’t load <b>$DEGENZ</b> from the launchpad right now. Try again in a moment."
        : "Could not build the DEGENZ shill card.";
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCallbackQuery({ text: "Shill failed", show_alert: true });
      } catch {
        // expired
      }
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  try {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  } catch {
    // ignore
  }

  await ctx.replyWithPhoto(new InputFile(built.png, "shill.png"), {
    caption: built.caption,
    parse_mode: "HTML",
    reply_markup: shillKeyboard(built.coin),
  });
}

export function registerShillCommand(bot: Bot, provider?: RpcProvider): void {
  burnProvider = provider ?? null;
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

    const arg = ctx.match?.trim() || "";
    if (!argLooksLikeDegenz(arg)) {
      await ctx.reply("/shill is <b>$DEGENZ</b> only. Send <code>/shill</code> or <code>/shill degenz</code>.", {
        parse_mode: "HTML",
      });
      return;
    }

    await sendDegenzShill(ctx);
  });
}
