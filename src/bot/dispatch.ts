import type { Bot } from "grammy";
import type { RpcProvider } from "starknet";
import { tokensByAddress, updateToken } from "../store/db.ts";
import { getMarketSnapshot, getOhlcv, getQuotePriceUsd } from "../market/geckoterminal.ts";
import { renderChartPng } from "../chart/render.ts";
import { buildAlert, valueFromSwap } from "./format.ts";
import { formatUsd, normalizeAddress, shortAddress } from "../lib/format.ts";
import { enqueueAlert } from "./queue.ts";
import type { ClassifiedSwap } from "../types.ts";

async function senderOf(provider: RpcProvider, txHash: string): Promise<string> {
  try {
    const tx = await provider.getTransactionByHash(txHash);
    const sender =
      (tx as { sender_address?: string }).sender_address ??
      (tx as { senderAddress?: string }).senderAddress;
    return sender || "0x0";
  } catch {
    return "0x0";
  }
}

export function attachDispatcher(bot: Bot, provider: RpcProvider) {
  const posted = new Set<string>();

  return async function onSwap(swap: ClassifiedSwap): Promise<void> {
    try {
      await dispatchBuy(swap);
    } catch (error) {
      console.warn("Dispatch failed:", error);
    }
  };

  async function dispatchBuy(swap: ClassifiedSwap): Promise<void> {
    const tokens = tokensByAddress(swap.tokenAddress);
    if (!tokens.length) return;

    const legs = swap.paidLegs.length
      ? swap.paidLegs
      : [{ address: swap.quoteAddress, amount: swap.quoteAmount }];
    const [market, ...legPrices] = await Promise.all([
      getMarketSnapshot(swap.tokenAddress),
      ...legs.map((leg) => getQuotePriceUsd(leg.address)),
    ]);
    const quotePrices = new Map<string, number | null>();
    legs.forEach((leg, i) => {
      quotePrices.set(normalizeAddress(leg.address), legPrices[i] ?? null);
    });
    const wallet = await senderOf(provider, swap.transactionHash);

    let chartPng: Buffer | null = null;
    const needsChart = tokens.some((token) => token.chartEnabled && !token.gifUrl);
    if (needsChart) {
      try {
        const candles = await getOhlcv(market?.pairAddress ?? tokens[0]?.pairAddress);
        chartPng = renderChartPng(tokens[0]!.symbol, candles);
      } catch (error) {
        console.warn("Chart render failed:", error);
      }
    }

    for (const token of tokens) {
      if (swap.side !== "buy") continue;

      const values = valueFromSwap(swap, token, market, quotePrices);
      if (values.usdValue < token.minUsd) {
        console.log(
          `Skip ${token.symbol} buy ${formatUsd(values.usdValue)} < min ${formatUsd(token.minUsd)} tx ${shortAddress(swap.transactionHash)}`,
        );
        continue;
      }
      console.log(
        `Post ${token.symbol} buy ${formatUsd(values.usdValue)} hops=${swap.hopCount} tx ${swap.transactionHash}`,
      );

      const postKey = `${token.chatId}:${swap.transactionHash}:${swap.tokenAddress}:buy`;
      if (posted.has(postKey)) continue;
      posted.add(postKey);
      if (posted.size > 8_000) posted.clear();

      const whale = values.usdValue >= token.whaleUsd;
      const card = buildAlert({
        token,
        swap,
        market,
        ...values,
        wallet,
        whale,
      });

      enqueueAlert(bot.api, {
        chatId: token.chatId,
        caption: card.caption,
        keyboard: card.keyboard,
        gifUrl: card.gifUrl,
        chartPng: token.chartEnabled && !card.gifUrl ? chartPng : null,
      });

      if (market?.priceUsd && token.priceAlertPct != null && token.lastPriceUsd) {
        const move = ((market.priceUsd - token.lastPriceUsd) / token.lastPriceUsd) * 100;
        if (Math.abs(move) >= token.priceAlertPct) {
          const dir = move >= 0 ? "up" : "down";
          enqueueAlert(bot.api, {
            chatId: token.chatId,
            caption: `<b>${token.symbol} price ${dir} ${move.toFixed(1)}%</b>\nNow ${formatUsd(market.priceUsd)}`,
            keyboard: card.keyboard,
            gifUrl: null,
            chartPng: token.chartEnabled ? chartPng : null,
          });
        }
      }

      if (market?.priceUsd) {
        updateToken(token.id, {
          lastPriceUsd: market.priceUsd,
          pairAddress: market.pairAddress ?? token.pairAddress,
        });
      }
    }
  }
}
