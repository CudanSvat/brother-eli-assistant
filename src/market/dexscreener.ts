import { QUOTE_TOKENS } from "../config.ts";
import { fetchJson, normalizeAddress } from "../lib/format.ts";
import type { MarketSnapshot } from "../types.ts";

interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h1?: number; h24?: number };
  fdv?: number;
  marketCap?: number;
}

interface DexSearchResponse {
  pairs?: DexPair[];
}

const cache = new Map<string, { at: number; value: MarketSnapshot | null }>();
const CACHE_MS = 8_000;

function scorePair(pair: DexPair, token: string): number {
  const base = normalizeAddress(pair.baseToken.address) === token;
  const quote = normalizeAddress(pair.quoteToken.address);
  const quoteKnown = Boolean(QUOTE_TOKENS[quote]);
  const liq = pair.liquidity?.usd ?? 0;
  return (base ? 10_000_000 : 0) + (quoteKnown ? 1_000_000 : 0) + liq;
}

function snapshotFromPair(best: DexPair, token: string): MarketSnapshot {
  const tokenIsBase = normalizeAddress(best.baseToken.address) === token;
  return {
    priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
    priceNative: best.priceNative ?? null,
    marketCap: best.marketCap ?? best.fdv ?? null,
    liquidityUsd: best.liquidity?.usd ?? null,
    volume24h: best.volume?.h24 ?? null,
    change1h: best.priceChange?.h1 ?? null,
    change24h: best.priceChange?.h24 ?? null,
    pairAddress: best.pairAddress,
    pairUrl: best.url,
    quoteSymbol: tokenIsBase ? best.quoteToken.symbol : best.baseToken.symbol,
    quotePriceUsd: null,
    dexId: best.dexId,
  };
}

async function fetchDexPairs(token: string): Promise<DexPair[]> {
  const urls = [
    `https://api.dexscreener.com/latest/dex/tokens/${token}`,
    `https://api.dexscreener.com/token-pairs/v1/starknet/${token}`,
  ];
  for (const url of urls) {
    try {
      const body = await fetchJson<DexPair[] | DexSearchResponse>(url);
      const pairs = Array.isArray(body) ? body : (body.pairs ?? []);
      if (pairs.length) return pairs;
    } catch {
      // try the next DexScreener shape
    }
  }
  return [];
}

export async function getMarketForToken(tokenAddress: string): Promise<MarketSnapshot | null> {
  const token = normalizeAddress(tokenAddress);
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  try {
    const pairs = await fetchDexPairs(token);
    const stark = pairs.filter((pair) => pair.chainId === "starknet" || !pair.chainId);
    const best = [...stark].sort((a, b) => scorePair(b, token) - scorePair(a, token))[0];
    if (!best) {
      cache.set(token, { at: Date.now(), value: null });
      return null;
    }
    const snapshot = snapshotFromPair(best, token);
    cache.set(token, { at: Date.now(), value: snapshot });
    return snapshot;
  } catch (error) {
    console.warn("DexScreener lookup failed:", error);
    cache.set(token, { at: Date.now(), value: null });
    return null;
  }
}

export function dexScreenerTokenUrl(address: string): string {
  return `https://dexscreener.com/starknet/${normalizeAddress(address)}`;
}
