import { SLAY_CHART_FEE, SLAY_TOKEN, STRK_TOKEN } from "../src/config.ts";
import { chartSpotFromHops, humanToken1PerToken0, usdFromSqrtRatio } from "../src/market/pool-price.ts";
import type { DecodedSwap } from "../src/types.ts";

const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";

function hop(partial: Partial<DecodedSwap> & { token0: string; token1: string; fee: bigint }): DecodedSwap {
  return {
    locker: "0x1",
    poolKey: {
      token0: partial.token0,
      token1: partial.token1,
      fee: partial.fee,
      tickSpacing: 5982n,
      extension: "0x0",
    },
    delta0: 1n,
    delta1: -1n,
    sqrtRatioAfter: partial.sqrtRatioAfter ?? 1n,
    transactionHash: "0xabc",
    blockNumber: 1,
  };
}

// Ekubo docs: ETH/USDC sqrt_ratio → ~1569 USDC per ETH.
const docsSqrt = BigInt("0x029895c9cbfca44f2c46e6e9b5459b");
const usdcPerEth = humanToken1PerToken0(docsSqrt, 18, 6);
if (Math.abs(usdcPerEth - 1569.14) > 1) {
  throw new Error(`docs price ${usdcPerEth}`);
}

const slayPerStrkSqrt = (() => {
  // 0.07 STRK per SLAY → sqrt_ratio = 2^128 * sqrt(0.07)
  const raw = Math.sqrt(0.07);
  return BigInt(Math.round(raw * 2 ** 52)) << 76n;
})();

const strkUsd = 0.028;
const chartHop = hop({
  token0: SLAY_TOKEN,
  token1: STRK_TOKEN,
  fee: SLAY_CHART_FEE,
  sqrtRatioAfter: slayPerStrkSqrt,
});
const usdcHop = hop({
  token0: SLAY_TOKEN,
  token1: USDC,
  fee: SLAY_CHART_FEE / 20n,
  sqrtRatioAfter: 1n << 200n,
});

const spot = chartSpotFromHops([usdcHop, chartHop], SLAY_TOKEN);
if (!spot) throw new Error("expected SLAY/STRK 1% hop as chart spot");
if (spot.sqrtRatio !== slayPerStrkSqrt) throw new Error("picked the USDC hop");

const usdcOnly = chartSpotFromHops([usdcHop], SLAY_TOKEN);
if (usdcOnly) throw new Error("USDC-only fill must not set chart spot");

const usd = usdFromSqrtRatio({
  sqrtRatio: slayPerStrkSqrt,
  token0: SLAY_TOKEN,
  token1: STRK_TOKEN,
  tokenAddress: SLAY_TOKEN,
  tokenDecimals: 18,
  quotePriceUsd: (address) => (address.includes("4718f5a0") ? strkUsd : null),
});
if (usd == null || Math.abs(usd - 0.07 * strkUsd) / (0.07 * strkUsd) > 0.02) {
  throw new Error(`chart usd ${usd}`);
}

console.log("chart-pool spot OK", usd);
