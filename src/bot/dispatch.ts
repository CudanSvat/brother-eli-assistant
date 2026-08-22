import type { Bot } from "grammy";
import { tokensByAddress, updateToken, bumpAthForAddress } from "../store/db.ts";
import { getMarketSnapshot, getQuotePriceUsd, resolveChartPair } from "../market/geckoterminal.ts";
import { checkBuyAth } from "./ath.ts";
import { buildAlert, valueFromSwap } from "./format.ts";
import { formatTokenPrice, formatUsd, normalizeAddress, shortAddress } from "../lib/format.ts";
import { enqueueAlert } from "./queue.ts";
import type { ClassifiedSwap } from "../types.ts";

export function attachDispatcher(bot: Bot) {
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

    const chartPair = resolveChartPair(swap.tokenAddress, tokens[0]?.pairAddress);

    for (const token of tokens) {
      if (swap.side !== "buy") continue;

      const values = valueFromSwap(swap, token, market, quotePrices);
      const execPrice =
        values.usdValue > 0 && values.tokenUnits > 0 ? values.usdValue / values.tokenUnits : null;
      const athCheck = await checkBuyAth(
        token,
        chartPair ?? resolveChartPair(swap.tokenAddress, token.pairAddress),
        execPrice,
      );
      const newAth = athCheck?.newAth ?? false;
      const meetsMin = values.usdValue >= token.minUsd;

      if (!meetsMin && !newAth) {
        console.log(
          `Skip ${token.symbol} buy ${formatUsd(values.usdValue)} < min ${formatUsd(token.minUsd)} tx ${shortAddress(swap.transactionHash)}`,
        );
        continue;
      }

      console.log(
        `Post ${token.symbol} buy ${formatUsd(values.usdValue)} hops=${swap.hopCount} tx ${swap.transactionHash}${newAth ? " NEW_ATH" : ""}${!meetsMin && newAth ? " (below min)" : ""}`,
      );

      const postKey = `${token.chatId}:${swap.transactionHash}:${swap.tokenAddress}:buy`;
      if (posted.has(postKey)) continue;
      posted.add(postKey);
      if (posted.size > 8_000) posted.clear();

      const card = buildAlert({
        token,
        swap,
        market,
        ...values,
        newAth: athCheck?.newAth,
        previousAth: athCheck?.previousAth,
      });

      enqueueAlert(bot.api, {
        chatId: token.chatId,
        caption: card.caption,
        links: card.links,
        gifUrl: card.gifUrl,
      });

      if (meetsMin && market?.priceUsd && token.priceAlertPct != null && token.lastPriceUsd) {
        const trackPrice =
          values.usdValue > 0 && values.tokenUnits > 0
            ? values.usdValue / values.tokenUnits
            : market.priceUsd;
        const move = ((trackPrice - token.lastPriceUsd) / token.lastPriceUsd) * 100;
        if (Math.abs(move) >= token.priceAlertPct) {
          const dir = move >= 0 ? "up" : "down";
          enqueueAlert(bot.api, {
            chatId: token.chatId,
            caption: `<b>${token.symbol} price ${dir} ${move.toFixed(1)}%</b>\nNow ${formatTokenPrice(trackPrice)}`,
            links: card.links,
            gifUrl: null,
          });
        }
      }

      const trackPrice = execPrice ?? market?.priceUsd ?? null;
      if (trackPrice) {
        updateToken(token.id, {
          lastPriceUsd: trackPrice,
          pairAddress: resolveChartPair(swap.tokenAddress, market?.pairAddress ?? token.pairAddress),
          athPriceUsd: athCheck?.nextAth ?? token.athPriceUsd,
        });
        if (athCheck?.nextAth) {
          bumpAthForAddress(swap.tokenAddress, athCheck.nextAth);
        }
      }
    }
  }
}
