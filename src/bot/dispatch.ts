import type { Bot } from "grammy";
import { tokensByAddress, updateToken, bumpAthForAddress, wasPosted, markPosted } from "../store/db.ts";
import {
  chartQuoteForToken,
  getMarketSnapshot,
  getQuotePriceUsd,
  resolveChartPair,
} from "../market/geckoterminal.ts";
import { usdFromSqrtRatio } from "../market/pool-price.ts";
import { checkBuyAth, shouldAnnounceAth } from "./ath.ts";
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
    const chartQuote = chartQuoteForToken(swap.tokenAddress);
    const quoteAddrs = [
      ...new Set(
        [
          ...legs.map((leg) => normalizeAddress(leg.address)),
          ...(chartQuote ? [normalizeAddress(chartQuote)] : []),
        ].filter(Boolean),
      ),
    ];
    const [market, ...legPrices] = await Promise.all([
      getMarketSnapshot(swap.tokenAddress),
      ...quoteAddrs.map((address) => getQuotePriceUsd(address)),
    ]);
    const quotePrices = new Map<string, number | null>();
    quoteAddrs.forEach((address, i) => {
      quotePrices.set(address, legPrices[i] ?? null);
    });

    const chartPair = resolveChartPair(swap.tokenAddress, tokens[0]?.pairAddress);

    for (const token of tokens) {
      if (swap.side !== "buy") continue;

      const values = valueFromSwap(swap, token, market, quotePrices);
      const execPrice =
        values.usdValue > 0 && values.tokenUnits > 0 ? values.usdValue / values.tokenUnits : null;
      const chartUsd = swap.chartSpot
        ? usdFromSqrtRatio({
            ...swap.chartSpot,
            tokenAddress: token.address,
            tokenDecimals: token.decimals,
            quotePriceUsd: (address) => {
              const chartQuoteAddr = chartQuote ? normalizeAddress(chartQuote) : null;
              if (chartQuoteAddr && normalizeAddress(address) === chartQuoteAddr && market?.quotePriceUsd) {
                return market.quotePriceUsd;
              }
              return quotePrices.get(normalizeAddress(address)) ?? null;
            },
          })
        : null;
      const spotPrice = chartUsd ?? market?.priceUsd ?? token.lastPriceUsd ?? null;
      const athCheck = await checkBuyAth(
        token,
        chartPair ?? resolveChartPair(swap.tokenAddress, token.pairAddress),
        chartUsd,
      );
      const priceHitAth = athCheck?.newAth ?? false;
      const announceAth = shouldAnnounceAth(token, values.usdValue, priceHitAth);
      const meetsMin = values.usdValue >= token.minUsd;

      // Keep the high-water mark even when we don't post an ATH card.
      if (priceHitAth && athCheck?.nextAth) {
        bumpAthForAddress(swap.tokenAddress, athCheck.nextAth);
      }

      if (!meetsMin && !announceAth) {
        console.log(
          `Skip ${token.symbol} buy ${formatUsd(values.usdValue)} < min ${formatUsd(token.minUsd)} tx ${shortAddress(swap.transactionHash)}${priceHitAth && !announceAth ? " ATH quiet" : ""}`,
        );
        continue;
      }

      console.log(
        `Post ${token.symbol} buy ${formatUsd(values.usdValue)} hops=${swap.hopCount} tx ${swap.transactionHash}${announceAth ? " NEW_ATH" : ""}${!meetsMin && announceAth ? " (below min)" : ""} spot=${spotPrice != null ? formatTokenPrice(spotPrice) : "—"} fill=${execPrice != null ? formatTokenPrice(execPrice) : "—"}`,
      );

      const postKey = `${token.chatId}:${swap.transactionHash}:${swap.tokenAddress}:buy`;
      if (posted.has(postKey) || wasPosted(postKey)) continue;
      posted.add(postKey);
      markPosted(postKey);
      if (posted.size > 8_000) posted.clear();

      const card = buildAlert({
        token,
        swap,
        market,
        ...values,
        spotPrice,
        newAth: announceAth,
        previousAth: athCheck?.previousAth,
      });

      enqueueAlert(bot.api, {
        chatId: token.chatId,
        caption: card.caption,
        links: card.links,
        gifUrl: card.gifUrl,
      });

      if (meetsMin && spotPrice && token.priceAlertPct != null && token.lastPriceUsd) {
        const move = ((spotPrice - token.lastPriceUsd) / token.lastPriceUsd) * 100;
        if (Math.abs(move) >= token.priceAlertPct) {
          const dir = move >= 0 ? "up" : "down";
          enqueueAlert(bot.api, {
            chatId: token.chatId,
            caption: `<b>${token.symbol} price ${dir} ${move.toFixed(1)}%</b>\nNow ${formatTokenPrice(spotPrice)}`,
            links: card.links,
            gifUrl: null,
          });
        }
      }

      const trackPrice = chartUsd ?? market?.priceUsd ?? token.lastPriceUsd ?? null;
      if (trackPrice) {
        updateToken(token.id, {
          lastPriceUsd: trackPrice,
          pairAddress: resolveChartPair(swap.tokenAddress, market?.pairAddress ?? token.pairAddress),
          athPriceUsd: athCheck?.nextAth ?? token.athPriceUsd,
        });
      }
    }
  }
}
