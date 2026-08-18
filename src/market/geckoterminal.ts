import { QUOTE_TOKENS } from "../config.ts";
import { fetchJson, normalizeAddress } from "../lib/format.ts";
import { getMarketForToken as getDexMarket } from "./dexscreener.ts";
import type { Candle, MarketSnapshot } from "../types.ts";

const NETWORK = "starknet-alpha";
const CACHE_MS = 8_000;
const marketCache = new Map<string, { at: number; value: MarketSnapshot | null }>();
const ohlcvCache = new Map<string, { at: number; candles: Candle[] }>();

interface GeckoTokenResponse {
  data?: {
    attributes?: {
      price_usd?: string | null;
      fdv_usd?: string | null;
      market_cap_usd?: string | null;
      total_reserve_in_usd?: string | null;
      volume_usd?: { h24?: string };
    };
    relationships?: {
      top_pools?: { data?: Array<{ id: string }> };
    };
  };
  included?: Array<{
    type?: string;
    attributes?: {
      address?: string;
      reserve_in_usd?: string;
      volume_usd?: { h24?: string };
      price_change_percentage?: { h1?: string; h24?: string };
    };
  }>;
}

interface OhlcvResponse {
  data?: {
    attributes?: {
      ohlcv_list?: Array<[number, number, number, number, number, number]>;
    };
  };
}

function num(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function geckoPoolAddress(id: string | undefined): string | null {
  if (!id) return null;
  const hex = id.split("_").pop();
  return hex?.startsWith("0x") ? hex : null;
}

export function geckoPoolUrl(pool: string): string {
  return `https://www.geckoterminal.com/${NETWORK}/pools/${pool}`;
}

export function geckoTokenUrl(address: string): string {
  return `https://www.geckoterminal.com/${NETWORK}/tokens/${normalizeAddress(address)}`;
}

export function isHexPool(address: string | null | undefined): boolean {
  return Boolean(address && /^0x[0-9a-fA-F]{1,64}$/.test(address) && !address.includes("-"));
}

async function fetchGeckoMarket(tokenAddress: string): Promise<MarketSnapshot | null> {
  const token = normalizeAddress(tokenAddress);
  const body = await fetchJson<GeckoTokenResponse>(
    `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/tokens/${token}?include=top_pools`,
  );
  const attrs = body.data?.attributes;
  const pool = geckoPoolAddress(body.data?.relationships?.top_pools?.data?.[0]?.id);
  const topPool = body.included?.find((item) => item.type === "pool")?.attributes;
  const price = num(attrs?.price_usd);
  if (!price && !pool) return null;

  return {
    priceUsd: price,
    priceNative: null,
    marketCap: num(attrs?.market_cap_usd) ?? num(attrs?.fdv_usd),
    liquidityUsd: num(topPool?.reserve_in_usd) ?? num(attrs?.total_reserve_in_usd),
    volume24h: num(topPool?.volume_usd?.h24) ?? num(attrs?.volume_usd?.h24),
    change1h: num(topPool?.price_change_percentage?.h1),
    change24h: num(topPool?.price_change_percentage?.h24),
    pairAddress: pool ?? (topPool?.address ? normalizeAddress(topPool.address) : null),
    pairUrl: pool ? geckoPoolUrl(pool) : geckoTokenUrl(token),
    quoteSymbol: null,
    dexId: "ekubo",
  };
}

export async function getGeckoMarket(tokenAddress: string): Promise<MarketSnapshot | null> {
  const token = normalizeAddress(tokenAddress);
  const hit = marketCache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  try {
    const snapshot = await fetchGeckoMarket(token);
    marketCache.set(token, { at: Date.now(), value: snapshot });
    return snapshot;
  } catch (error) {
    console.warn("GeckoTerminal lookup failed:", error);
    marketCache.set(token, { at: Date.now(), value: null });
    return null;
  }
}

function mergeGeckoFirst(
  gecko: MarketSnapshot | null,
  dex: MarketSnapshot | null,
): MarketSnapshot | null {
  if (!gecko) return dex;
  if (!dex) return gecko;
  return {
    ...gecko,
    priceUsd: gecko.priceUsd ?? dex.priceUsd,
    marketCap: gecko.marketCap ?? dex.marketCap,
    liquidityUsd: gecko.liquidityUsd ?? dex.liquidityUsd,
    volume24h: gecko.volume24h ?? dex.volume24h,
    change1h: gecko.change1h ?? dex.change1h,
    change24h: gecko.change24h ?? dex.change24h,
    pairAddress: gecko.pairAddress ?? (isHexPool(dex.pairAddress) ? dex.pairAddress : null),
    pairUrl: gecko.pairUrl || dex.pairUrl,
  };
}

/** GeckoTerminal first; DexScreener only if gecko has no usable snapshot. */
export async function getMarketSnapshot(tokenAddress: string): Promise<MarketSnapshot | null> {
  const gecko = await getGeckoMarket(tokenAddress);
  if (gecko?.priceUsd) return gecko;
  const dex = await getDexMarket(tokenAddress);
  return mergeGeckoFirst(gecko, dex);
}

const STABLES = new Set(["USDC", "USDT"]);

export async function getQuotePriceUsd(quoteAddress: string): Promise<number | null> {
  const meta = QUOTE_TOKENS[normalizeAddress(quoteAddress)];
  if (meta && STABLES.has(meta.symbol)) return 1;
  const gecko = await getGeckoMarket(quoteAddress);
  if (gecko?.priceUsd && gecko.priceUsd > 0) return gecko.priceUsd;
  const dex = await getDexMarket(quoteAddress);
  return dex?.priceUsd && dex.priceUsd > 0 ? dex.priceUsd : null;
}

async function tryOhlcv(network: string, pool: string): Promise<Candle[]> {
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}` +
    `/ohlcv/minute?aggregate=5&limit=48&currency=usd`;
  const body = await fetchJson<OhlcvResponse>(url);
  const list = body.data?.attributes?.ohlcv_list ?? [];
  return list.map(([time, open, high, low, close, volume]) => ({
    time,
    open,
    high,
    low,
    close,
    volume,
  }));
}

export async function getOhlcv(pairAddress: string | null | undefined): Promise<Candle[]> {
  if (!pairAddress || !isHexPool(pairAddress)) return [];
  const key = pairAddress.toLowerCase();
  const hit = ohlcvCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.candles;

  for (const network of [NETWORK, "starknet"]) {
    try {
      const candles = await tryOhlcv(network, pairAddress);
      if (candles.length) {
        ohlcvCache.set(key, { at: Date.now(), candles });
        return candles;
      }
    } catch {
      // try next network id
    }
  }
  ohlcvCache.set(key, { at: Date.now(), candles: [] });
  return [];
}
