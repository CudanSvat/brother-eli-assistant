import { netTransaction } from "../src/indexer/classify.ts";
import type { DecodedSwap } from "../src/types.ts";

const ETH = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const TOKEN = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function hop(
  token0: string,
  token1: string,
  delta0: bigint,
  delta1: bigint,
): DecodedSwap {
  return {
    locker: "0x1",
    poolKey: { token0, token1, fee: 0n, tickSpacing: 0n, extension: "0x0" },
    delta0,
    delta1,
    sqrtRatioAfter: null,
    transactionHash: "0xabc",
    blockNumber: 1,
  };
}

// AVNU: 40% ETH→TOKEN, 60% ETH→STRK→TOKEN in one tx
const hops = [
  hop(ETH, TOKEN, -40n, 400n),
  hop(ETH, STRK, -60n, 60n),
  hop(STRK, TOKEN, -60n, 600n),
];

const merged = netTransaction(hops, TOKEN);
if (!merged) throw new Error("expected a merge");
if (merged.side !== "buy") throw new Error("expected buy");
if (merged.tokenAmount !== 1000n) throw new Error(`token ${merged.tokenAmount}`);
if (merged.quoteAmount !== 100n) throw new Error(`quote ${merged.quoteAmount}`);
if (!merged.quoteAddress.endsWith("dc7")) throw new Error(`quote token ${merged.quoteAddress}`);
if (merged.hopCount !== 3) throw new Error(`hops ${merged.hopCount}`);
if (merged.paidLegs.length !== 1) throw new Error(`paid ${merged.paidLegs.length}`);
console.log("AVNU netting OK", merged);

// Parallel split: pay STRK and USDC into SLAY in the same tx (the latest AVNU fill).
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const SLAY = "0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2";
const split = netTransaction(
  [
    hop(SLAY, USDC, 8136730286556577575924n, -7143036n),
    hop(SLAY, STRK, 4673635815427907174863n, -182252490075000000000n),
  ],
  SLAY,
);
if (!split) throw new Error("expected split merge");
if (split.side !== "buy") throw new Error(`split side ${split.side}`);
if (split.paidLegs.length !== 2) throw new Error(`split paid ${split.paidLegs.length}`);
if (split.tokenAmount !== 8136730286556577575924n + 4673635815427907174863n) {
  throw new Error(`split token ${split.tokenAmount}`);
}
console.log("AVNU split STRK+USDC OK", split.paidLegs.length);
