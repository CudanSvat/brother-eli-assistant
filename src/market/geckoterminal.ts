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

/** How long a successful series pack stays warm (button switches hit cache). */
const SERIES_CACHE_MS = 90_000;
const BUYCARD_CACHE_MS = 20_000;

type OhlcvUnit = "minute" | "hour" | "day";

interface SeriesPack {
  at: number;
  fine: Candle[]; // 5m
  mid: Candle[]; // 15m
  hour: Candle[]; // 1h
  day: Candle[]; // 1d
}

const seriesPackCache = new Map<string, SeriesPack>();
const seriesPackInflight = new Map<string, Promise<SeriesPack>>();
let geckoCooldownUntil = 0;

export function isChartWindow(value: string): value is ChartWindow {
  return (CHART_WINDOWS as string[]).includes(value);
}

export function chartWindowLabel(window: ChartWindow): string {
  if (window === "1m") return "1M";
  if (window === "all") return "All";
  return window;
}

function candleSec(c: Candle): number {
  return c.time < 1e12 ? c.time : Math.floor(c.time / 1000);
}

function filterByWindow(candles: Candle[], window: ChartWindow): Candle[] {
  if (window === "all" || !Number.isFinite(WINDOW_MS[window])) return candles;
  const cutoffSec = Math.floor((Date.now() - WINDOW_MS[window]) / 1000);
  return candles.filter((c) => candleSec(c) >= cutoffSec);
}

function parseOhlcvStatus(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const m = msg.match(/^(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

async function tryOhlcv(
  pool: string,
  unit: OhlcvUnit,
  aggregate: number,
  limit: number,
): Promise<Candle[]> {
  if (Date.now() < geckoCooldownUntil) {
    throw new Error(`429 Too Many Requests (cooldown ${Math.ceil((geckoCooldownUntil - Date.now()) / 1000)}s)`);
  }

  const url =
    `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pool}` +
    `/ohlcv/${unit}?aggregate=${aggregate}&limit=${limit}&currency=usd`;

  try {
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
  } catch (error) {
    const status = parseOhlcvStatus(error);
    if (status === 429) {
      geckoCooldownUntil = Date.now() + 20_000;
      console.warn(`Gecko OHLCV rate-limited; cooling down 20s`);
    } else if (status !== 404) {
      console.warn(`Gecko OHLCV ${unit}/${aggregate} failed:`, status ?? error);
    }
    throw error;
  }
}

/** At most one request in flight per pool; max 4 Gecko calls on a cold load. */
async function loadSeriesPack(pool: string): Promise<SeriesPack> {
  const key = pool.toLowerCase();
  const hit = seriesPackCache.get(key);
  if (hit && Date.now() - hit.at < SERIES_CACHE_MS) return hit;

  const inflight = seriesPackInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<SeriesPack> => {
    const pack: SeriesPack = {
      at: Date.now(),
      fine: hit?.fine ?? [],
      mid: hit?.mid ?? [],
      hour: hit?.hour ?? [],
      day: hit?.day ?? [],
    };

    const loads: Array<{ field: keyof Omit<SeriesPack, "at">; unit: OhlcvUnit; agg: number; limit: number }> = [
      { field: "fine", unit: "minute", agg: 5, limit: 90 },
      { field: "mid", unit: "minute", agg: 15, limit: 120 },
      { field: "hour", unit: "hour", agg: 1, limit: 200 },
      { field: "day", unit: "day", agg: 1, limit: 400 },
    ];

    for (const load of loads) {
      if (Date.now() < geckoCooldownUntil) break;
      try {
        const candles = await tryOhlcv(pool, load.unit, load.agg, load.limit);
        if (candles.length) pack[load.field] = candles;
      } catch {
        // keep prior / empty; continue only if not cooling down hard
        if (Date.now() < geckoCooldownUntil) break;
      }
    }

    pack.at = Date.now();
    seriesPackCache.set(key, pack);
    return pack;
  })().finally(() => {
    seriesPackInflight.delete(key);
  });

  seriesPackInflight.set(key, promise);
  return promise;
}

function pickSeriesForWindow(
  pack: SeriesPack,
  window: ChartWindow,
): { candles: Candle[]; intervalLabel: string } {
  const candidates: Array<{ candles: Candle[]; label: string }> = [];
  if (window === "6h") {
    candidates.push({ candles: pack.fine, label: "5m" }, { candles: pack.mid, label: "15m" });
  } else if (window === "1d") {
    candidates.push({ candles: pack.mid, label: "15m" }, { candles: pack.fine, label: "5m" }, { candles: pack.hour, label: "1h" });
  } else if (window === "3d" || window === "7d") {
    candidates.push({ candles: pack.hour, label: "1h" }, { candles: pack.mid, label: "15m" }, { candles: pack.day, label: "1d" });
  } else if (window === "1m") {
    candidates.push({ candles: pack.day, label: "1d" }, { candles: pack.hour, label: "1h" });
  } else {
    candidates.push({ candles: pack.day, label: "1d" }, { candles: pack.hour, label: "1h" });
  }

  let best: { candles: Candle[]; label: string } | null = null;
  for (const c of candidates) {
    const sliced = filterByWindow(c.candles, window);
    if (sliced.length < 2) continue;
    if (!best || sliced.length > best.candles.length) {
      best = { candles: sliced, label: c.label };
    }
    if (sliced.length >= 24) return { candles: sliced, intervalLabel: c.label };
  }
  return best
    ? { candles: best.candles, intervalLabel: best.label }
    : { candles: [], intervalLabel: candidates[0]?.label ?? "15m" };
}

export interface OhlcvResult {
  candles: Candle[];
  intervalLabel: string;
  window: ChartWindow;
}

/** Buy-card chart: short recent traded window from the shared series pack. */
export async function getOhlcv(pairAddress: string | null | undefined): Promise<Candle[]> {
  if (!pairAddress || !isHexPool(pairAddress)) return [];
  const key = `${pairAddress.toLowerCase()}:buycard`;
  const hit = ohlcvCache.get(key);
  if (hit && Date.now() - hit.at < BUYCARD_CACHE_MS) return hit.candles;

  try {
    const pack = await loadSeriesPack(pairAddress);
    const candles =
      pack.mid.length >= 8 ? pack.mid.slice(-64) : pack.fine.length >= 8 ? pack.fine.slice(-72) : pack.hour.slice(-48);
    ohlcvCache.set(key, { at: Date.now(), candles, label: pack.mid.length ? "15m" : "5m" });
    return candles;
  } catch {
    ohlcvCache.set(key, { at: Date.now(), candles: [], label: "15m" });
    return [];
  }
}

export async function getOhlcvForWindow(
  pairAddress: string | null | undefined,
  window: ChartWindow = DEFAULT_CHART_WINDOW,
): Promise<OhlcvResult> {
  if (!pairAddress || !isHexPool(pairAddress)) {
    return { candles: [], intervalLabel: "15m", window };
  }

  const pack = await loadSeriesPack(pairAddress);
  const picked = pickSeriesForWindow(pack, window);
  return { ...picked, window };
}
