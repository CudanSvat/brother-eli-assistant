/**
 * Dry-run a past buy through receipt enrich + valuation.
 * Does NOT post to Telegram — free to re-check without buying again.
 *
 * Usage:
 *   npx tsx scripts/replay-tx.ts 0x06e33f90...
 *   npx tsx scripts/replay-tx.ts   # defaults to the $256 miss
 */
import { RpcProvider } from "starknet";
import { createProvider, EkuboListener } from "../src/indexer/listener.ts";
import { netTransaction } from "../src/indexer/classify.ts";
import { SLAY_TOKEN, config } from "../src/config.ts";
import { formatUsd, normalizeAddress } from "../src/lib/format.ts";
import { valueFromSwap } from "../src/bot/format.ts";
import { getQuotePriceUsd, getMarketSnapshot } from "../src/market/geckoterminal.ts";
import type { TokenSettings } from "../src/types.ts";

const hash =
  process.argv[2]?.trim() ||
  "0x06e33f9087b6e0a2ab1c72481640ffb6e36edb88a9bd3d6caed014b9e56c8229";

const mins = [200, 1000];

async function main(): Promise<void> {
  const provider = createProvider();
  // Listener only used for hopsFromReceipt helper.
  const listener = new EkuboListener(provider, async () => {});
  const hops = await listener.hopsFromReceipt(hash, []);
  console.log(`tx ${hash}`);
  console.log(`receipt hops: ${hops.length}`);
  if (!hops.length) {
    console.log("No Ekubo Swapped events — nothing to post.");
    return;
  }

  const swap = netTransaction(hops, SLAY_TOKEN);
  if (!swap) {
    console.log("Not a net SLAY buy/sell after netting.");
    return;
  }

  const token = {
    id: 1,
    chatId: 0,
    address: SLAY_TOKEN,
    symbol: "SLAY",
    name: "SLAY",
    decimals: 18,
    minUsd: 200,
    pairAddress: null,
    quoteAddress: null,
    emoji: "🟢",
    emojiStepUsd: 50,
    gifUrl: null,
    whaleGifUrl: null,
    athGifUrl: null,
    whaleUsd: 1000,
    chartEnabled: true,
    priceAlertPct: null,
    lastPriceUsd: null,
    athPriceUsd: null,
    athMinUsd: 0,
  } satisfies TokenSettings;

  const legs = swap.paidLegs.length
    ? swap.paidLegs
    : [{ address: swap.quoteAddress, amount: swap.quoteAmount }];
  const quoteAddrs = [...new Set(legs.map((l) => normalizeAddress(l.address)))];
  const [market, ...prices] = await Promise.all([
    getMarketSnapshot(SLAY_TOKEN),
    ...quoteAddrs.map((a) => getQuotePriceUsd(a)),
  ]);
  const quotePrices = new Map(quoteAddrs.map((a, i) => [a, prices[i] ?? null]));
  const values = valueFromSwap(swap, token, market, quotePrices);

  console.log({
    side: swap.side,
    hopCount: swap.hopCount,
    usd: formatUsd(values.usdValue),
    got: values.tokenUnits,
    quoteSymbol: values.quoteSymbol,
    quoteUnits: values.quoteUnits,
    rpc: config.rpcUrl.replace(/alch_[A-Za-z0-9_-]+/, "alch_…").replace(/_hKu4[A-Za-z0-9_-]+/, "_hKu…"),
  });

  for (const min of mins) {
    const ok = values.usdValue >= min;
    console.log(`min ${formatUsd(min)} → ${ok ? "POST" : "SKIP"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
