import { decodeSwapped } from "../src/indexer/decode.ts";
import { netTransaction } from "../src/indexer/classify.ts";
import { normalizeAddress } from "../src/lib/format.ts";

const SLAY = "0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const TX = "0x054456d9bac673be6abb4ef8412a81ba318ff90af328583fa6fe2bd272fcd69b";
const SELECTOR = "0x0157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870";

// Real AVNU fill: 500 STRK → USDC → 12,839.297304 SLAY (block 13505261).
const hopStrkToUsdc = decodeSwapped({
  keys: [SELECTOR],
  data: [
    "0x199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e",
    "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
    "0x20c49ba5e353f80000000000000000",
    "0x3e8",
    "0x0",
    "0x1b13f47b891b9e0000",
    "0x0",
    "0x1",
    "0x925293fd0313030a017330671707197",
    "0x65ba82",
    "0x64",
    "0xab6537",
    "0x1",
    "0x1b13f47b891b9e0000",
    "0x0",
    "0xc684169941b7cacd781ec7b98f3345be",
    "0x65ba61",
    "0x1df8333",
    "0x0",
    "0xd6c4babdcc7b8f60",
  ],
  transaction_hash: TX,
  block_number: 13505261,
});

const hopUsdcToSlay = decodeSwapped({
  keys: [SELECTOR],
  data: [
    "0x199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e",
    "0x2ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2",
    "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    "0xc49ba5e353f7d00000000000000000",
    "0x175e",
    "0x0",
    "0xab6537",
    "0x0",
    "0x1",
    "0x7f3f215ec887e4a35c9acfa503",
    "0x0",
    "0x64",
    "0x2b80509f15e0174bd03",
    "0x1",
    "0xab6537",
    "0x0",
    "0x7efac0069152d7771346994bf8",
    "0x0",
    "0x21112ea",
    "0x1",
    "0x27fbd7251a59743",
  ],
  transaction_hash: TX,
  block_number: 13505261,
});

if (hopUsdcToSlay.delta0 <= 0n) {
  throw new Error(`SLAY delta should be positive after decode, got ${hopUsdcToSlay.delta0}`);
}

const merged = netTransaction([hopStrkToUsdc, hopUsdcToSlay], SLAY);
if (!merged) throw new Error("expected a merge");
if (merged.side !== "buy") throw new Error(`expected buy, got ${merged.side}`);
if (merged.tokenAmount !== 12839296961932881607939n) {
  throw new Error(`token ${merged.tokenAmount}`);
}
if (merged.quoteAmount !== 499500000000000000000n) {
  throw new Error(`quote ${merged.quoteAmount}`);
}
if (normalizeAddress(merged.quoteAddress) !== normalizeAddress(STRK)) {
  throw new Error(`quote ${merged.quoteAddress}`);
}
if (merged.hopCount !== 2) throw new Error(`hops ${merged.hopCount}`);
if (merged.chartSpot) throw new Error("USDC hop must not be treated as the SLAY/STRK chart pool");
if (hopUsdcToSlay.sqrtRatioAfter == null) throw new Error("expected sqrt_ratio_after on USDC hop");
console.log("AVNU STRK→USDC→SLAY buy OK", merged.side, merged.tokenAmount.toString());
