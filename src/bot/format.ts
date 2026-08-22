import { InlineKeyboard } from "grammy";
import { BOT_NAME, BOT_TAGLINE, config } from "../config.ts";
import {
  escapeHtml,
  formatPct,
  formatTokenAmount,
  formatTokenPrice,
  formatUsd,
  normalizeAddress,
  quoteMeta,
  toUnitAmount,
} from "../lib/format.ts";
import { avnuSwapUrl, ekuboSwapUrl, starkscanTxUrl } from "../market/ekubo.ts";
import { geckoChartUrlForToken } from "../market/geckoterminal.ts";
import type { ClassifiedSwap, MarketSnapshot, TokenSettings } from "../types.ts";

export interface AlertPayload {
  token: TokenSettings;
  swap: ClassifiedSwap;
  market: MarketSnapshot | null;
  usdValue: number;
  tokenUnits: number;
  quoteUnits: number;
  quoteSymbol: string;
}

export function buildAlert(input: AlertPayload): {
  caption: string;
  gifUrl: string | null;
  links: AlertLinks;
} {
  const { token, swap, market, usdValue, tokenUnits } = input;
  const emoji = token.emoji;
  const step = Math.max(1, token.emojiStepUsd);
  const count = Math.min(50, Math.max(1, Math.round(usdValue / step)));
  const ladder = Array.from({ length: count }, () => emoji).join("");
  const execPrice = tokenUnits > 0 && usdValue > 0 ? usdValue / tokenUnits : null;
  const prevPrice = token.lastPriceUsd;
  const trackedPrice = execPrice ?? market?.priceUsd ?? null;
  const move =
    trackedPrice != null && prevPrice != null && Number.isFinite(prevPrice) && prevPrice > 0
      ? ((trackedPrice - prevPrice) / prevPrice) * 100
      : null;
  const moveText = move != null && Number.isFinite(move) && move !== 0 ? formatPct(move) : "";
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
    `<b>${title}</b>`,
    "",
    spentUsd,
    ...paidLines,
    `Got: ${formatTokenAmount(tokenUnits)} ${escapeHtml(token.symbol)}`,
    swap.hopCount > 1 ? `Route: 1 buy across ${swap.hopCount} pools` : "",
    trackedPrice
      ? `Price: ${formatTokenPrice(trackedPrice)}${execPrice != null ? " (this buy)" : ""}${
          moveText ? `  (${moveText} vs prev)` : ""
        }`
      : `Price: —`,
    `MC ${formatUsd(market?.marketCap)} · Liq ${formatUsd(market?.liquidityUsd)} · Vol ${formatUsd(market?.volume24h)}`,
  ].filter((line) => line !== "");

  const links: AlertLinks = {
    tx: starkscanTxUrl(swap.transactionHash),
    gecko: geckoChartUrlForToken(token.address, market),
    ekubo: ekuboSwapUrl(token.address),
    avnu: avnuSwapUrl(token.address, token.symbol),
  };

  return { caption: lines.join("\n"), gifUrl: token.gifUrl, links };
}

export interface AlertLinks {
  tx: string;
  gecko: string;
  ekubo: string;
  avnu: string;
}

export function alertKeyboard(
  links: AlertLinks,
  toggle?: { id: string; show: "chart" | "gif" },
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .url("TX", links.tx)
    .url("Gecko Chart", links.gecko)
    .url("Ekubo", links.ekubo)
    .url("AVNU", links.avnu);
  if (toggle) {
    kb.row().text(toggle.show === "chart" ? "Chart" : "GIF", `s:${toggle.id}:${toggle.show === "chart" ? "c" : "g"}`);
  }
  return kb;
}

export function adminHomeText(
  count: number,
  group?: { title?: string | null; chatId: number },
): string {
  const where = group
    ? [
        `Managing: <b>${escapeHtml(group.title || "group")}</b>`,
        `ID: <code>${group.chatId}</code>`,
        "",
      ]
    : [];
  return [
    `<b>${BOT_NAME}</b>`,
    BOT_TAGLINE,
    "",
    ...where,
    `Tracked tokens: <b>${count}/${config.maxTokensPerGroup}</b>`,
    "",
    "Add a token by contract address. Buy alerts are live now. AVNU/Fibrous split routes in one transaction are merged into a single buy. More helper tools are coming.",
  ].join("\n");
}

export function connectGroupText(): string {
  return [
    `<b>${BOT_NAME}</b>`,
    "Configure a group from this chat — same settings as in the group.",
    "",
    "You must be a <b>group admin</b>, and I must already be in the group.",
    "",
    "Send the group ID (starts with <code>-100</code>), or forward any message from the group here.",
  ].join("\n");
}

export function connectGroupKeyboard(groups: { chatId: number; title: string | null }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  groups.slice(0, 8).forEach((group, i) => {
    const label = (group.title || String(group.chatId)).slice(0, 32);
    kb.text(label, `g:open:${group.chatId}`);
    if (i % 2 === 1) kb.row();
  });
  if (groups.length % 2 === 1) kb.row();
  kb.text("Help", "t:help").text("Close", "t:close");
  return kb;
}

export function tokenCardText(token: TokenSettings): string {
  return [
    `<b>${escapeHtml(token.symbol)}</b>  (${escapeHtml(token.name)})`,
    `<code>${token.address}</code>`,
    "",
    `Min buy: <b>${formatUsd(token.minUsd)}</b>`,
    `Emoji: ${token.emoji}  ·  one extra every ${formatUsd(token.emojiStepUsd)}`,
    `GIF: ${token.gifUrl ? "set" : "none"}`,
    `Chart: ${token.chartEnabled ? "on" : "off"}`,
    `Price ping: ${token.priceAlertPct != null ? `when price moves ±${token.priceAlertPct}%` : "off"}`,
  ].join("\n");
}

export function homeKeyboard(tokens: TokenSettings[], dm = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  tokens.forEach((token, i) => {
    kb.text(`${token.symbol}`, `t:view:${token.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (tokens.length % 2 === 1) kb.row();
  kb.text("+ Add token", "t:add").text("Help", "t:help");
  kb.row();
  if (dm) kb.text("Switch group", "g:switch");
  kb.text("Close", "t:close");
  return kb;
}

export function tokenKeyboard(token: TokenSettings): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Min ${formatUsd(token.minUsd)}`, `t:min:${token.id}`)
    .text(`Emoji ${token.emoji}`, `t:emoji:${token.id}`)
    .text(`Step ${formatUsd(token.emojiStepUsd)}`, `t:step:${token.id}`)
    .row()
    .text(token.gifUrl ? "Change GIF" : "Set GIF", `t:gif:${token.id}`)
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
