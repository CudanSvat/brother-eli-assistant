import { QUOTE_TOKENS } from "../config.ts";
import { fetchJson, normalizeAddress } from "../lib/format.ts";
import { getMarketForToken as getDexMarket } from "./dexscreener.ts";
import type { Candle, MarketSnapshot } from "../types.ts";

const NETWORK = "starknet-alpha";
const CACHE_MS = 8_000;
const marketCache = new Map<string, { at: number; value: MarketSnapshot | null }>();
const ohlcvCache = new Map<string, { at: number; candles: Candle[]; label: string }>();

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

export type ChartWindow = "6h" | "1d" | "3d" | "7d" | "1m" | "all";

export const CHART_WINDOWS: ChartWindow[] = ["6h", "1d", "3d", "7d", "1m", "all"];
export const DEFAULT_CHART_WINDOW: ChartWindow = "1d";

const WINDOW_MS: Record<ChartWindow, number> = {
  "6h": 6 * 3_600_000,
  "1d": 24 * 3_600_000,
  "3d": 3 * 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "1m": 30 * 24 * 3_600_000,
  all: Number.POSITIVE_INFINITY,
};

type OhlcvUnit = "minute" | "hour" | "day";

interface FetchPlan {
  unit: OhlcvUnit;
  aggregate: number;
  limit: number;
  label: string;
}

/** Gecko fetch plans per UI window (best → fallback). */
const WINDOW_PLANS: Record<ChartWindow, FetchPlan[]> = {
  "6h": [
    { unit: "minute", aggregate: 5, limit: 100, label: "5m" },
    { unit: "minute", aggregate: 15, limit: 40, label: "15m" },
  ],
  "1d": [
    { unit: "minute", aggregate: 15, limit: 120, label: "15m" },
    { unit: "minute", aggregate: 5, limit: 300, label: "5m" },
  ],
  "3d": [
    { unit: "minute", aggregate: 15, limit: 300, label: "15m" },
    { unit: "hour", aggregate: 1, limit: 80, label: "1h" },
  ],
  "7d": [
    { unit: "hour", aggregate: 1, limit: 180, label: "1h" },
    { unit: "minute", aggregate: 15, limit: 700, label: "15m" },
  ],
  "1m": [
    { unit: "hour", aggregate: 4, limit: 200, label: "4h" },
    { unit: "day", aggregate: 1, limit: 40, label: "1d" },
  ],
  all: [
    { unit: "day", aggregate: 1, limit: 365, label: "1d" },
    { unit: "hour", aggregate: 4, limit: 500, label: "4h" },
  ],
};

export function isChartWindow(value: string): value is ChartWindow {
  return (CHART_WINDOWS as string[]).includes(value);
}

export function chartWindowLabel(window: ChartWindow): string {
  if (window === "1m") return "1M";
  if (window === "all") return "All";
  return window;
}

async function tryOhlcv(
  network: string,
  pool: string,
  unit: OhlcvUnit,
  aggregate: number,
  limit: number,
): Promise<Candle[]> {
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}` +
    `/ohlcv/${unit}?aggregate=${aggregate}&limit=${limit}&currency=usd`;
  const body = await fetchJson<OhlcvResponse>(url);
  const list = body.data?.attributes?.ohlcv_list ?? [];
  return list
    .map(([time, open, high, low, close, volume]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    }))
    .sort((a, b) => a.time - b.time);
}

function filterByWindow(candles: Candle[], window: ChartWindow): Candle[] {
  if (window === "all" || !Number.isFinite(WINDOW_MS[window])) return candles;
  const cutoffSec = Math.floor((Date.now() - WINDOW_MS[window]) / 1000);
  return candles.filter((c) => {
    const t = c.time < 1e12 ? c.time : Math.floor(c.time / 1000);
    return t >= cutoffSec;
  });
}

export interface OhlcvResult {
  candles: Candle[];
  intervalLabel: string;
  window: ChartWindow;
}

/** Buy-card chart: short recent traded window (15m / 5m). */
export async function getOhlcv(pairAddress: string | null | undefined): Promise<Candle[]> {
  if (!pairAddress || !isHexPool(pairAddress)) return [];
  const key = `${pairAddress.toLowerCase()}:buycard`;
  const hit = ohlcvCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.candles;

  const plans: FetchPlan[] = [
    { unit: "minute", aggregate: 15, limit: 64, label: "15m" },
    { unit: "minute", aggregate: 5, limit: 72, label: "5m" },
  ];
  for (const network of [NETWORK, "starknet"]) {
    for (const plan of plans) {
      try {
        const candles = await tryOhlcv(network, pairAddress, plan.unit, plan.aggregate, plan.limit);
        if (candles.length >= 8) {
          ohlcvCache.set(key, { at: Date.now(), candles, label: plan.label });
          return candles;
        }
      } catch {
        // try next
      }
    }
  }
  ohlcvCache.set(key, { at: Date.now(), candles: [], label: "15m" });
  return [];
}

export async function getOhlcvForWindow(
  pairAddress: string | null | undefined,
  window: ChartWindow = DEFAULT_CHART_WINDOW,
): Promise<OhlcvResult> {
  if (!pairAddress || !isHexPool(pairAddress)) {
    return { candles: [], intervalLabel: "15m", window };
  }

  const key = `${pairAddress.toLowerCase()}:${window}`;
  const hit = ohlcvCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) {
    return { candles: hit.candles, intervalLabel: hit.label, window };
  }

  const plans = WINDOW_PLANS[window];
  for (const network of [NETWORK, "starknet"]) {
    for (const plan of plans) {
      try {
        const raw = await tryOhlcv(network, pairAddress, plan.unit, plan.aggregate, plan.limit);
        const candles = filterByWindow(raw, window);
        if (candles.length >= 3) {
          ohlcvCache.set(key, { at: Date.now(), candles, label: plan.label });
          return { candles, intervalLabel: plan.label, window };
        }
      } catch {
        // try next plan / network
      }
    }
  }

  ohlcvCache.set(key, { at: Date.now(), candles: [], label: plans[0]!.label });
  return { candles: [], intervalLabel: plans[0]!.label, window };
}
