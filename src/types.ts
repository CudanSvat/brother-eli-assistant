export type Side = "buy" | "sell";

export interface TokenSettings {
  id: number;
  chatId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  pairAddress: string | null;
  quoteAddress: string | null;
  minUsd: number;
  emoji: string;
  emojiStepUsd: number;
  gifUrl: string | null;
  whaleGifUrl: string | null;
  whaleUsd: number;
  chartEnabled: boolean;
  priceAlertPct: number | null;
  lastPriceUsd: number | null;
}

export interface SignedAmount {
  mag: bigint;
  negative: boolean;
}

export interface PoolKey {
  token0: string;
  token1: string;
  fee: bigint;
  tickSpacing: bigint;
  extension: string;
}

export interface DecodedSwap {
  locker: string;
  poolKey: PoolKey;
  delta0: bigint;
  delta1: bigint;
  transactionHash: string;
  blockNumber: number;
}

export interface PaidLeg {
  address: string;
  amount: bigint;
}

export interface ClassifiedSwap {
  side: Side;
  tokenAddress: string;
  tokenAmount: bigint;
  quoteAddress: string;
  quoteAmount: bigint;
  paidLegs: PaidLeg[];
  transactionHash: string;
  blockNumber: number;
  locker: string;
  hopCount: number;
}

export interface MarketSnapshot {
  priceUsd: number | null;
  priceNative: string | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  change1h: number | null;
  change24h: number | null;
  pairAddress: string | null;
  pairUrl: string | null;
  quoteSymbol: string | null;
  dexId: string | null;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PendingAction =
  | { kind: "add_token"; chatId: number }
  | { kind: "set_min"; chatId: number; tokenId: number }
  | { kind: "set_emoji"; chatId: number; tokenId: number }
  | { kind: "set_step"; chatId: number; tokenId: number }
  | { kind: "set_gif"; chatId: number; tokenId: number }
  | { kind: "set_whale_gif"; chatId: number; tokenId: number }
  | { kind: "set_whale_usd"; chatId: number; tokenId: number }
  | { kind: "set_price_pct"; chatId: number; tokenId: number };
