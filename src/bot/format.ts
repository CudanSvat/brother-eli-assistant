import { InlineKeyboard } from "grammy";
import { BOT_NAME, BOT_TAGLINE, config } from "../config.ts";
import {
  escapeHtml,
  formatPct,
  formatTokenAmount,
  formatUsd,
  normalizeAddress,
  quoteMeta,
  shortAddress,
  toUnitAmount,
} from "../lib/format.ts";
import { avnuSwapUrl, ekuboSwapUrl, starkscanAddressUrl, starkscanTxUrl } from "../market/ekubo.ts";
import { geckoTokenUrl } from "../market/geckoterminal.ts";
import { dexScreenerTokenUrl } from "../market/dexscreener.ts";
import type { ClassifiedSwap, MarketSnapshot, TokenSettings } from "../types.ts";

export interface AlertPayload {
  token: TokenSettings;
  swap: ClassifiedSwap;
  market: MarketSnapshot | null;
  usdValue: number;
  tokenUnits: number;
  quoteUnits: number;
  quoteSymbol: string;
  wallet: string;
  whale: boolean;
}

export function buildAlert(input: AlertPayload): {
  caption: string;
  keyboard: InlineKeyboard;
  gifUrl: string | null;
} {
  const { token, swap, market, usdValue, tokenUnits, wallet, whale } = input;
  const emoji = token.emoji;
  const step = Math.max(1, token.emojiStepUsd);
  const count = Math.min(50, Math.max(1, Math.round(usdValue / step)));
  const ladder = Array.from({ length: count }, () => emoji).join("");
  const change = formatPct(market?.change1h);
  const title = `${escapeHtml(token.symbol)} Buy!`;

  const spentUsd = `Spent: ${formatUsd(usdValue)}`;
  const paidLines = (swap.paidLegs.length ? swap.paidLegs : [{ address: swap.quoteAddress, amount: swap.quoteAmount }])
    .map((leg) => {
      const meta = quoteMeta(leg.address);
      const units = toUnitAmount(leg.amount, meta.decimals);
      if (units <= 0) return "";
      return `${escapeHtml(meta.symbol)}: ${formatTokenAmount(units)}`;
    })
    .filter(Boolean);

  const lines = [
    ladder,
    `<b>${title}</b>${whale ? "  🐋" : ""}`,
    "",
    spentUsd,
    ...paidLines,
    `Got: ${formatTokenAmount(tokenUnits)} ${escapeHtml(token.symbol)}`,
    swap.hopCount > 1 ? `Route: 1 buy across ${swap.hopCount} pools` : "",
    `Price: ${formatUsd(market?.priceUsd)}${change ? `  (${change} 1h)` : ""}`,
    `MC ${formatUsd(market?.marketCap)} · Liq ${formatUsd(market?.liquidityUsd)} · Vol ${formatUsd(market?.volume24h)}`,
    `Wallet: <a href="${starkscanAddressUrl(wallet)}">${shortAddress(wallet)}</a>`,
  ].filter((line) => line !== "");

  const keyboard = new InlineKeyboard()
    .url("TX", starkscanTxUrl(swap.transactionHash))
    .url("Chart", market?.pairUrl || geckoTokenUrl(token.address) || dexScreenerTokenUrl(token.address))
    .url("Ekubo", ekuboSwapUrl(token.address))
    .url("Buy", avnuSwapUrl(token.address));

  const gifUrl = whale && token.whaleGifUrl ? token.whaleGifUrl : token.gifUrl;

  return { caption: lines.join("\n"), keyboard, gifUrl };
}

export function adminHomeText(count: number): string {
  return [
    `<b>${BOT_NAME}</b>`,
    BOT_TAGLINE,
    "",
    `Tracked tokens: <b>${count}/${config.maxTokensPerGroup}</b>`,
    "",
    "Add a token by contract address. Buy alerts are live now. AVNU/Fibrous split routes in one transaction are merged into a single buy. More helper tools are coming.",
  ].join("\n");
}

export function tokenCardText(token: TokenSettings): string {
  return [
    `<b>${escapeHtml(token.symbol)}</b>  (${escapeHtml(token.name)})`,
    `<code>${token.address}</code>`,
    "",
    `Min buy: <b>${formatUsd(token.minUsd)}</b>`,
    `Emoji: ${token.emoji}  ·  one extra every ${formatUsd(token.emojiStepUsd)}`,
    `GIF: ${token.gifUrl ? "set" : "none"}   ·  Whale GIF: ${token.whaleGifUrl ? "set" : "none"}`,
    `Whale: buys from <b>${formatUsd(token.whaleUsd)}</b>`,
    `Chart: ${token.chartEnabled ? "on" : "off"}`,
    `Price ping: ${token.priceAlertPct != null ? `when price moves ±${token.priceAlertPct}%` : "off"}`,
  ].join("\n");
}

export function homeKeyboard(tokens: TokenSettings[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  tokens.forEach((token, i) => {
    kb.text(`${token.symbol}`, `t:view:${token.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (tokens.length % 2 === 1) kb.row();
  kb.text("+ Add token", "t:add").text("Help", "t:help");
  kb.row().text("Close", "t:close");
  return kb;
}

export function tokenKeyboard(token: TokenSettings): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Min ${formatUsd(token.minUsd)}`, `t:min:${token.id}`)
    .text(`Emoji ${token.emoji}`, `t:emoji:${token.id}`)
    .text(`Step ${formatUsd(token.emojiStepUsd)}`, `t:step:${token.id}`)
    .row()
    .text(token.gifUrl ? "Change GIF" : "Set GIF", `t:gif:${token.id}`)
    .text(token.whaleGifUrl ? "Change whale GIF" : "Whale GIF", `t:wgif:${token.id}`)
    .row()
    .text(`Whale ${formatUsd(token.whaleUsd)}`, `t:whale:${token.id}`)
    .text(token.chartEnabled ? "Chart: on" : "Chart: off", `t:chart:${token.id}`)
    .row()
    .text(
      token.priceAlertPct != null ? `Price ping ±${token.priceAlertPct}%` : "Price ping: off",
      `t:price:${token.id}`,
    )
    .text("Remove", `t:del:${token.id}`)
    .row()
    .text("« Back", "t:home")
    .text("Close", "t:close");
}

export function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Cancel", "t:cancel");
}

export function valueFromSwap(
  swap: ClassifiedSwap,
  token: TokenSettings,
  market: MarketSnapshot | null,
  quotePrices: Map<string, number | null>,
): { usdValue: number; tokenUnits: number; quoteUnits: number; quoteSymbol: string } {
  const tokenUnits = toUnitAmount(swap.tokenAmount, token.decimals);
  const quote = quoteMeta(swap.quoteAddress);
  const quoteUnits = toUnitAmount(swap.quoteAmount, quote.decimals);
  const legs = swap.paidLegs.length
    ? swap.paidLegs
    : [{ address: swap.quoteAddress, amount: swap.quoteAmount }];

  let usdValue = 0;
  for (const leg of legs) {
    const meta = quoteMeta(leg.address);
    const units = toUnitAmount(leg.amount, meta.decimals);
    const price = quotePrices.get(normalizeAddress(leg.address));
    if (price != null && price > 0 && units > 0) {
      usdValue += units * price;
    } else if (meta.symbol === "USDC" || meta.symbol === "USDT") {
      usdValue += units;
    }
  }
  if (usdValue <= 0 && market?.priceUsd) {
    usdValue = tokenUnits * market.priceUsd;
  }
  return { usdValue, tokenUnits, quoteUnits, quoteSymbol: quote.symbol };
}
