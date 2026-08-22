import { addressesEqual, isQuoteToken, normalizeAddress, quoteMeta } from "../lib/format.ts";
import { chartFeeForToken, chartQuoteForToken } from "./geckoterminal.ts";
import type { ChartSpot, DecodedSwap } from "../types.ts";

const STABLES = new Set(["USDC", "USDT"]);

function feeNear(fee: bigint, target: bigint): boolean {
  const delta = fee > target ? fee - target : target - fee;
  return delta <= target / 20n;
}

function hopTouches(hop: DecodedSwap, tokenAddress: string): boolean {
  return (
    addressesEqual(hop.poolKey.token0, tokenAddress) ||
    addressesEqual(hop.poolKey.token1, tokenAddress)
  );
}

function hopOtherToken(hop: DecodedSwap, tokenAddress: string): string {
  return addressesEqual(hop.poolKey.token0, tokenAddress) ? hop.poolKey.token1 : hop.poolKey.token0;
}

/**
 * The hop that moved the Gecko chart pool in this tx.
 * For SLAY that is SLAY/STRK 1% — not a USDC side pool and not the blended fill.
 */
export function pickChartHop(hops: DecodedSwap[], tokenAddress: string): DecodedSwap | null {
  const tracked = normalizeAddress(tokenAddress);
  const quote = chartQuoteForToken(tracked);
  const fee = chartFeeForToken(tracked);
  const involving = hops.filter(
    (hop) => hopTouches(hop, tracked) && hop.sqrtRatioAfter != null && hop.sqrtRatioAfter > 0n,
  );
  if (!involving.length) return null;

  if (quote) {
    const onPair = involving.filter((hop) => addressesEqual(hopOtherToken(hop, tracked), quote));
    const onFee = fee != null ? onPair.filter((hop) => feeNear(hop.poolKey.fee, fee)) : onPair;
    const hit = onFee.at(-1) ?? null;
    if (!hit && onPair.length) {
      console.warn(
        `Chart quote hops found but none at chart fee for ${tracked}: ${onPair.length} vs quote, ${onFee.length} at fee`,
      );
    }
    return hit;
  }

  const stables = involving.filter((hop) => {
    const meta = quoteMeta(hopOtherToken(hop, tracked));
    return STABLES.has(meta.symbol);
  });
  if (stables.length) return stables.at(-1) ?? null;

  const quoted = involving.filter((hop) => isQuoteToken(hopOtherToken(hop, tracked)));
  return (quoted.at(-1) ?? involving.at(-1)) ?? null;
}

export function chartSpotFromHops(hops: DecodedSwap[], tokenAddress: string): ChartSpot | null {
  const hop = pickChartHop(hops, tokenAddress);
  if (!hop?.sqrtRatioAfter) return null;
  return {
    sqrtRatio: hop.sqrtRatioAfter,
    token0: hop.poolKey.token0,
    token1: hop.poolKey.token1,
  };
}

/** token1 per token0, human units. sqrt_ratio is Ekubo 64.128. */
export function humanToken1PerToken0(sqrtRatio: bigint, decimals0: number, decimals1: number): number {
  if (sqrtRatio <= 0n) return NaN;
  let x = sqrtRatio;
  let exp2 = 0;
  while (x > 1n << 53n) {
    x >>= 1n;
    exp2 += 1;
  }
  const sqrtFloat = Number(x) * 2 ** exp2;
  return (sqrtFloat / 2 ** 128) ** 2 * 10 ** (decimals0 - decimals1);
}

export function usdFromSqrtRatio(input: {
  sqrtRatio: bigint;
  token0: string;
  token1: string;
  tokenAddress: string;
  tokenDecimals: number;
  quotePriceUsd: (address: string) => number | null;
}): number | null {
  const token = normalizeAddress(input.tokenAddress);
  const token0 = normalizeAddress(input.token0);
  const token1 = normalizeAddress(input.token1);
  const is0 = addressesEqual(token0, token);
  const is1 = addressesEqual(token1, token);
  if (is0 === is1) return null;

  const quote = is0 ? token1 : token0;
  const quoteUsd = input.quotePriceUsd(quote);
  if (quoteUsd == null || !(quoteUsd > 0)) return null;

  const dec0 = is0 ? input.tokenDecimals : quoteMeta(token0).decimals;
  const dec1 = is1 ? input.tokenDecimals : quoteMeta(token1).decimals;
  const t1PerT0 = humanToken1PerToken0(input.sqrtRatio, dec0, dec1);
  if (!Number.isFinite(t1PerT0) || t1PerT0 <= 0) return null;

  const priceInQuote = is0 ? t1PerT0 : 1 / t1PerT0;
  const usd = priceInQuote * quoteUsd;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}
