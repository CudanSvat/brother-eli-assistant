import {
  QUOTE_TOKENS,
  SLAY_CHART_FEE,
  SLAY_CHART_POOL,
  SLAY_CHART_QUOTE,
  SLAY_TOKEN,
  config,
} from "../config.ts";
import { fetchJson, isStarknetAddress, normalizeAddress, quoteMeta, sleep } from "../lib/format.ts";
import { getMarketForToken as getDexMarket } from "./dexscreener.ts";
import type { Candle, MarketSnapshot } from "../types.ts";

const NETWORK = "starknet-alpha";
const CACHE_MS = 60_000;
const marketCache = new Map<string, { at: number; value: MarketSnapshot | null }>();
const poolCache = new Map<string, { at: number; value: MarketSnapshot | null }>();
const ohlcvCache = new Map<string, { at: number; candles: Candle[]; label: string }>();
let geckoCooldownUntil = 0;

type OhlcvUnit = "minute" | "hour" | "day";

function ohlcvBaseUrl(pool: string, unit: OhlcvUnit): string {
  if (config.coingeckoApiKey) {
    return `https://pro-api.coingecko.com/api/v3/onchain/networks/${NETWORK}/pools/${pool}/ohlcv/${unit}`;
  }
  return `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pool}/ohlcv/${unit}`;
}

function ohlcvHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.coingeckoApiKey) {
    headers["x-cg-pro-api-key"] = config.coingeckoApiKey;
  }
  return headers;
}

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
  included?: GeckoPoolIncluded[];
}

interface GeckoPoolIncluded {
  type?: string;
  id?: string;
  attributes?: {
    address?: string;
    reserve_in_usd?: string;
    volume_usd?: { h24?: string };
    price_change_percentage?: { h1?: string; h24?: string };
  };
}

interface GeckoPoolResponse {
  data?: {
    attributes?: {
      address?: string;
      base_token_price_usd?: string | null;
      quote_token_price_usd?: string | null;
      reserve_in_usd?: string;
      volume_usd?: { h24?: string };
      fdv_usd?: string | null;
      market_cap_usd?: string | null;
      price_change_percentage?: { h1?: string; h24?: string };
    };
    relationships?: {
      base_token?: { data?: { id?: string } };
      quote_token?: { data?: { id?: string } };
    };
  };
  included?: Array<{
    type?: string;
    id?: string;
    attributes?: { address?: string; symbol?: string };
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
  return hex?.startsWith("0x") ? normalizeAddress(hex) : null;
}

function poolAddressFromIncluded(item: GeckoPoolIncluded): string | null {
  const fromId = geckoPoolAddress(item.id);
  if (fromId) return fromId;
  const raw = item.attributes?.address;
  return raw ? normalizeAddress(raw) : null;
}

/** Prefer the pool with the most 24h volume — that is usually where buys land. */
function pickBestGeckoPool(included: GeckoPoolIncluded[] | undefined): GeckoPoolIncluded | null {
  const pools = (included ?? []).filter((item) => item.type === "pool");
  if (!pools.length) return null;
  return [...pools].sort((a, b) => {
    const volDiff = (num(b.attributes?.volume_usd?.h24) ?? 0) - (num(a.attributes?.volume_usd?.h24) ?? 0);
    if (volDiff !== 0) return volDiff;
    return (num(b.attributes?.reserve_in_usd) ?? 0) - (num(a.attributes?.reserve_in_usd) ?? 0);
  })[0] ?? null;
}

function pairScore(snapshot: MarketSnapshot | null): number {
  if (!snapshot?.pairAddress || !isHexPool(snapshot.pairAddress)) return -1;
  return (snapshot.volume24h ?? 0) * 1_000 + (snapshot.liquidityUsd ?? 0);
}

export function geckoPoolUrl(pool: string): string {
  return `https://www.geckoterminal.com/${NETWORK}/pools/${pool}`;
}

function cleanPastedUrl(raw: string): string {
  return raw.trim().replace(/[\u200b-\u200d\ufeff]/g, "");
}

function geckoHexFromPath(raw: string, kind: "pools" | "tokens"): string | null {
  const text = cleanPastedUrl(raw);
  const match = text.match(
    new RegExp(`geckoterminal\\.com(?:/[^\\s/]+)*/${kind}/(0x[0-9a-fA-F]+)`, "i"),
  );
  return match?.[1] && isStarknetAddress(match[1]) ? normalizeAddress(match[1]) : null;
}

/** GeckoTerminal / DexScreener pool URL only — not a raw token address. */
export function parsePoolUrl(raw: string): string | null {
  const fromGecko = geckoHexFromPath(raw, "pools");
  if (fromGecko) return fromGecko;
  const dex = cleanPastedUrl(raw).match(/dexscreener\.com\/starknet\/(0x[0-9a-fA-F]+)/i);
  if (dex?.[1] && isStarknetAddress(dex[1])) return normalizeAddress(dex[1]);
  return null;
}

/** GeckoTerminal token page URL. */
export function parseTokenUrl(raw: string): string | null {
  return geckoHexFromPath(raw, "tokens");
}

/** Pool URL or a 0x pool/token address. */
export function parsePoolInput(raw: string): string | null {
  const fromUrl = parsePoolUrl(raw);
  if (fromUrl) return fromUrl;
  const text = raw.trim();
  if (isStarknetAddress(text) && isHexPool(text)) return normalizeAddress(text);
  return null;
}

export async function resolveGeckoPool(pool: string): Promise<{
  poolAddress: string;
  baseToken: string;
  quoteToken: string | null;
} | null> {
  if (!isHexPool(pool)) return null;
  const address = normalizeAddress(pool);
  try {
    const body = await fetchJson<GeckoPoolResponse>(
      `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${address}?include=base_token,quote_token`,
    );
    const included = body.included ?? [];
    const addrFromId = (id: string | undefined): string | null => {
      const hit = included.find((item) => item.id === id && item.type === "token");
      const raw = hit?.attributes?.address ?? geckoPoolAddress(id);
      return raw && isStarknetAddress(raw) ? normalizeAddress(raw) : geckoPoolAddress(id);
    };
    const baseToken = addrFromId(body.data?.relationships?.base_token?.data?.id);
    if (!baseToken) return null;
    return {
      poolAddress: address,
      baseToken,
      quoteToken: addrFromId(body.data?.relationships?.quote_token?.data?.id),
    };
  } catch (error) {
    console.warn("Gecko pool resolve failed:", error);
    return null;
  }
}

export function geckoTokenUrl(address: string): string {
  return `https://www.geckoterminal.com/${NETWORK}/tokens/${normalizeAddress(address)}`;
}

export function isHexPool(address: string | null | undefined): boolean {
  return Boolean(address && /^0x[0-9a-fA-F]{1,64}$/.test(address) && !address.includes("-"));
}

/** Fixed Gecko pool for a token when configured (e.g. SLAY). */
export function chartPoolForToken(tokenAddress: string): string | null {
  const token = normalizeAddress(tokenAddress);
  if (token === normalizeAddress(SLAY_TOKEN)) {
    return normalizeAddress(SLAY_CHART_POOL);
  }
  return null;
}

/** Quote token of the pinned chart pool (STRK for SLAY). */
export function chartQuoteForToken(tokenAddress: string): string | null {
  const token = normalizeAddress(tokenAddress);
  if (token === normalizeAddress(SLAY_TOKEN)) {
    return normalizeAddress(SLAY_CHART_QUOTE);
  }
  return null;
}

/** Ekubo fee of the pinned chart pool, or null when any fee is fine. */
export function chartFeeForToken(tokenAddress: string): bigint | null {
  const token = normalizeAddress(tokenAddress);
  if (token === normalizeAddress(SLAY_TOKEN)) {
    return SLAY_CHART_FEE;
  }
  return null;
}

export function resolveChartPair(tokenAddress: string, fallback?: string | null): string | null {
  const override = chartPoolForToken(tokenAddress);
  if (override) return override;
  return fallback && isHexPool(fallback) ? normalizeAddress(fallback) : null;
}

function pinnedPoolFor(tokenAddress: string, hint?: string | null): string | null {
  return (
    chartPoolForToken(tokenAddress) ??
    (hint && isHexPool(hint) ? normalizeAddress(hint) : null)
  );
}

export function geckoChartUrlForToken(tokenAddress: string, market?: MarketSnapshot | null): string {
  const pool = pinnedPoolFor(tokenAddress, market?.pairAddress);
  if (pool) return geckoPoolUrl(pool);
  if (market?.pairUrl) return market.pairUrl;
  return geckoTokenUrl(tokenAddress);
}

function applyChartPoolOverride(
  tokenAddress: string,
  market: MarketSnapshot | null,
  poolSnap: MarketSnapshot | null,
  pinnedPool?: string | null,
): MarketSnapshot | null {
  const pool = pinnedPoolFor(tokenAddress, pinnedPool);
  if (!pool) return market;
  const quote = chartQuoteForToken(tokenAddress);
  const quoteSymbol = quote ? quoteMeta(quote).symbol : (poolSnap?.quoteSymbol ?? market?.quoteSymbol ?? null);
  const base = market ?? {
    priceUsd: null,
    priceNative: null,
    marketCap: null,
    liquidityUsd: null,
    volume24h: null,
    change1h: null,
    change24h: null,
    pairAddress: pool,
    pairUrl: geckoPoolUrl(pool),
    quoteSymbol,
    quotePriceUsd: null,
    dexId: "ekubo",
  };
  return {
    ...base,
    // Pinned tokens must use the chart pool's USD, never the blended token price.
    priceUsd: poolSnap?.priceUsd ?? null,
    quotePriceUsd: poolSnap?.quotePriceUsd ?? base.quotePriceUsd,
    liquidityUsd: poolSnap?.liquidityUsd ?? base.liquidityUsd,
    volume24h: poolSnap?.volume24h ?? base.volume24h,
    change1h: poolSnap?.change1h ?? base.change1h,
    change24h: poolSnap?.change24h ?? base.change24h,
    pairAddress: pool,
    pairUrl: geckoPoolUrl(pool),
    quoteSymbol,
    dexId: poolSnap?.dexId ?? base.dexId ?? "ekubo",
  };
}

async function fetchGeckoPool(pool: string): Promise<MarketSnapshot | null> {
  const body = await fetchJson<GeckoPoolResponse>(
    `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pool}`,
  );
  const attrs = body.data?.attributes;
  const price = num(attrs?.base_token_price_usd);
  if (price == null && !attrs) return null;
  return {
    priceUsd: price,
    priceNative: null,
    marketCap: num(attrs?.market_cap_usd) ?? num(attrs?.fdv_usd),
    liquidityUsd: num(attrs?.reserve_in_usd),
    volume24h: num(attrs?.volume_usd?.h24),
    change1h: num(attrs?.price_change_percentage?.h1),
    change24h: num(attrs?.price_change_percentage?.h24),
    pairAddress: normalizeAddress(pool),
    pairUrl: geckoPoolUrl(pool),
    quoteSymbol: null,
    quotePriceUsd: num(attrs?.quote_token_price_usd),
    dexId: "ekubo",
  };
}

async function getGeckoPool(pool: string): Promise<MarketSnapshot | null> {
  const key = normalizeAddress(pool);
  const hit = poolCache.get(key);
  if (hit && Date.now() - hit.at < config.chartCacheMs) return hit.value;
  if (Date.now() < geckoCooldownUntil && hit) return hit.value;

  try {
    const snapshot = await fetchGeckoPool(key);
    poolCache.set(key, { at: Date.now(), value: snapshot });
    return snapshot;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/\b429\b/.test(msg)) {
      geckoCooldownUntil = Date.now() + 20_000;
      console.warn("Gecko pool rate-limited; cooling down 20s");
      if (hit) return hit.value;
    }
    console.warn("Gecko pool lookup failed:", error);
    poolCache.set(key, { at: Date.now(), value: hit?.value ?? null });
    return hit?.value ?? null;
  }
}

async function fetchGeckoMarket(tokenAddress: string): Promise<MarketSnapshot | null> {
  const token = normalizeAddress(tokenAddress);
  const body = await fetchJson<GeckoTokenResponse>(
    `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/tokens/${token}?include=top_pools`,
  );
  const attrs = body.data?.attributes;
  const bestPool = pickBestGeckoPool(body.included);
  const pool =
    poolAddressFromIncluded(bestPool ?? {}) ??
    geckoPoolAddress(body.data?.relationships?.top_pools?.data?.[0]?.id);
  const poolAttrs = bestPool?.attributes;
  const price = num(attrs?.price_usd);
  if (!price && !pool) return null;

  return {
    priceUsd: price,
    priceNative: null,
    marketCap: num(attrs?.market_cap_usd) ?? num(attrs?.fdv_usd),
    liquidityUsd: num(poolAttrs?.reserve_in_usd) ?? num(attrs?.total_reserve_in_usd),
    volume24h: num(poolAttrs?.volume_usd?.h24) ?? num(attrs?.volume_usd?.h24),
    change1h: num(poolAttrs?.price_change_percentage?.h1),
    change24h: num(poolAttrs?.price_change_percentage?.h24),
    pairAddress: pool,
    pairUrl: pool ? geckoPoolUrl(pool) : geckoTokenUrl(token),
    quoteSymbol: null,
    quotePriceUsd: null,
    dexId: "ekubo",
  };
}

export async function getGeckoMarket(tokenAddress: string): Promise<MarketSnapshot | null> {
  const token = normalizeAddress(tokenAddress);
  const hit = marketCache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  // Prefer a slightly stale snapshot over hammering Gecko while rate-limited.
  if (Date.now() < geckoCooldownUntil && hit) return hit.value;

  try {
    const snapshot = await fetchGeckoMarket(token);
    marketCache.set(token, { at: Date.now(), value: snapshot });
    return snapshot;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/\b429\b/.test(msg)) {
      geckoCooldownUntil = Date.now() + 20_000;
      console.warn("Gecko market rate-limited; cooling down 20s");
      if (hit) return hit.value;
    }
    console.warn("GeckoTerminal lookup failed:", error);
    marketCache.set(token, { at: Date.now(), value: null });
    return hit?.value ?? null;
  }
}

function mergeMarketSnapshots(
  gecko: MarketSnapshot | null,
  dex: MarketSnapshot | null,
): MarketSnapshot | null {
  if (!gecko) return dex;
  if (!dex) return gecko;

  const geckoPairScore = pairScore(gecko);
  const dexPairScore = pairScore(dex);
  const bestPair =
    dexPairScore > geckoPairScore && isHexPool(dex.pairAddress)
      ? { pairAddress: dex.pairAddress, pairUrl: dex.pairUrl }
      : { pairAddress: gecko.pairAddress, pairUrl: gecko.pairUrl || dex.pairUrl };

  return {
    ...gecko,
    priceUsd: gecko.priceUsd ?? dex.priceUsd,
    marketCap: gecko.marketCap ?? dex.marketCap,
    liquidityUsd: gecko.liquidityUsd ?? dex.liquidityUsd,
    volume24h: gecko.volume24h ?? dex.volume24h,
    change1h: gecko.change1h ?? dex.change1h,
    change24h: gecko.change24h ?? dex.change24h,
    pairAddress: bestPair.pairAddress ?? (isHexPool(dex.pairAddress) ? dex.pairAddress : null),
    pairUrl: bestPair.pairUrl || dex.pairUrl || gecko.pairUrl,
    quoteSymbol: gecko.quoteSymbol ?? dex.quoteSymbol,
    quotePriceUsd: gecko.quotePriceUsd ?? dex.quotePriceUsd,
    dexId: gecko.dexId ?? dex.dexId,
  };
}

/** GeckoTerminal + DexScreener; pinned pool (SLAY env or stored pair) wins for price/charts. */
export async function getMarketSnapshot(
  tokenAddress: string,
  pinnedPool?: string | null,
): Promise<MarketSnapshot | null> {
  const pool = pinnedPoolFor(tokenAddress, pinnedPool);
  const [gecko, dex, chart] = await Promise.all([
    getGeckoMarket(tokenAddress),
    getDexMarket(tokenAddress),
    pool ? getGeckoPool(pool) : Promise.resolve(null),
  ]);
  return applyChartPoolOverride(tokenAddress, mergeMarketSnapshots(gecko, dex), chart, pool);
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

export type ChartWindow = "1d" | "3d" | "7d" | "1m" | "all";

export const CHART_WINDOWS: ChartWindow[] = ["1d", "3d", "7d", "1m", "all"];
export const DEFAULT_CHART_WINDOW: ChartWindow = "7d";

const WINDOW_MS: Record<ChartWindow, number> = {
  "1d": 24 * 3_600_000,
  "3d": 3 * 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "1m": 30 * 24 * 3_600_000,
  all: Number.POSITIVE_INFINITY,
};

/** How long a successful series pack stays warm (button switches hit cache). */
const SERIES_CACHE_MS = 90_000;
/** During Gecko 429 cooldown, serve last good candles up to this age. */
const STALE_SERIES_MS = 600_000;
const BUYCARD_CACHE_MS = 20_000;

interface SeriesPack {
  at: number;
  fine: Candle[]; // 5m
  mid: Candle[]; // 15m
  hour: Candle[]; // 1h
  day: Candle[]; // 1d
}

function seriesPackHasData(pack: SeriesPack): boolean {
  return pack.fine.length >= 2 || pack.mid.length >= 2 || pack.hour.length >= 2 || pack.day.length >= 2;
}

function cacheSeriesPack(key: string, pack: SeriesPack, previous?: SeriesPack): void {
  if (seriesPackHasData(pack)) {
    pack.at = Date.now();
    seriesPackCache.set(key, pack);
    return;
  }
  if (previous && seriesPackHasData(previous)) {
    seriesPackCache.set(key, previous);
  }
}

const seriesPackCache = new Map<string, SeriesPack>();
const seriesPackInflight = new Map<string, Promise<SeriesPack>>();

/** Preferred candle size per UI window (always pad empty slots to fill the axis). */
const WINDOW_PLAN: Record<
  ChartWindow,
  { field: keyof Omit<SeriesPack, "at">; label: string; intervalSec: number }
> = {
  "1d": { field: "mid", label: "15m", intervalSec: 15 * 60 },
  "3d": { field: "hour", label: "1h", intervalSec: 60 * 60 },
  "7d": { field: "hour", label: "1h", intervalSec: 60 * 60 },
  "1m": { field: "day", label: "1d", intervalSec: 24 * 60 * 60 },
  all: { field: "day", label: "1d", intervalSec: 24 * 60 * 60 },
};

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

function seedClose(candles: Candle[], beforeSec: number): number | null {
  let seed: number | null = null;
  for (const c of candles) {
    if (candleSec(c) <= beforeSec) seed = c.close;
    else break;
  }
  if (seed != null) return seed;
  return candles[0] ? candles[0].open : null;
}

/**
 * Fill every bucket from start→end with flat zero-volume candles when nothing traded.
 * Used for every timeframe so sparse markets still fill the plot width.
 */
function padEmptyBuckets(
  traded: Candle[],
  allSeries: Candle[],
  intervalSec: number,
  window: ChartWindow,
): Candle[] {
  if (intervalSec <= 0) return traded;
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = Math.floor(nowSec / intervalSec) * intervalSec;

  let startSec: number;
  if (window === "all") {
    const first = allSeries[0] ?? traded[0];
    if (!first) return traded;
    startSec = Math.floor(candleSec(first) / intervalSec) * intervalSec;
  } else {
    startSec = Math.floor((nowSec - WINDOW_MS[window] / 1000) / intervalSec) * intervalSec;
  }

  const byBucket = new Map<number, Candle>();
  for (const c of traded) {
    const bucket = Math.floor(candleSec(c) / intervalSec) * intervalSec;
    byBucket.set(bucket, { ...c, time: bucket });
  }

  let prevClose = seedClose(allSeries.length ? allSeries : traded, startSec);
  if (prevClose == null && traded[0]) prevClose = traded[0].open;
  if (prevClose == null) return traded;

  const filled: Candle[] = [];
  const maxBars = 800;
  const total = Math.floor((endSec - startSec) / intervalSec) + 1;
  const step = total > maxBars ? Math.ceil(total / maxBars) : 1;
  const stepSec = intervalSec * step;

  for (let t = startSec; t <= endSec; t += stepSec) {
    // Prefer a real trade inside this stepped bucket if present.
    let hit: Candle | undefined;
    for (let u = t; u < t + stepSec && u <= endSec; u += intervalSec) {
      const c = byBucket.get(u);
      if (c) hit = c;
    }
    if (hit) {
      filled.push({
        ...hit,
        time: t,
        open: hit.open,
        high: hit.high,
        low: hit.low,
        close: hit.close,
      });
      prevClose = hit.close;
    } else {
      filled.push({
        time: t,
        open: prevClose,
        high: prevClose,
        low: prevClose,
        close: prevClose,
        volume: 0,
      });
    }
  }
  return filled;
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
  opts: { beforeTimestamp?: number; includeEmpty?: boolean } = {},
): Promise<Candle[]> {
  if (Date.now() < geckoCooldownUntil) return [];

  const params = new URLSearchParams({
    aggregate: String(aggregate),
    limit: String(limit),
    currency: "usd",
  });
  if (opts.beforeTimestamp) params.set("before_timestamp", String(opts.beforeTimestamp));
  if (opts.includeEmpty) params.set("include_empty_intervals", "true");

  const url = `${ohlcvBaseUrl(pool, unit)}?${params}`;

  try {
    const body = await fetchJson<OhlcvResponse>(url, 12_000, ohlcvHeaders());
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
    } else if (status !== 404 && status !== 401) {
      console.warn(`Gecko OHLCV ${unit}/${aggregate} failed:`, status ?? error);
    }
    throw error;
  }
}

/** Walk backwards with before_timestamp until empty/401. Public API stops ~180d without a key. */
async function fetchDayHistory(pool: string): Promise<Candle[]> {
  const byTime = new Map<number, Candle>();
  let before: number | undefined;
  const maxPages = config.coingeckoApiKey ? 12 : 1;

  for (let page = 0; page < maxPages; page++) {
    if (Date.now() < geckoCooldownUntil) break;
    try {
      const batch = await tryOhlcv(pool, "day", 1, 1000, {
        beforeTimestamp: before,
        includeEmpty: true,
      });
      if (!batch.length) break;
      for (const c of batch) byTime.set(candleSec(c), c);
      const oldest = Math.min(...batch.map((c) => candleSec(c)));
      if (before != null && oldest >= before) break;
      before = oldest;
      if (batch.length < 50) break;
      if (page + 1 < maxPages) await sleep(350);
    } catch (error) {
      const status = parseOhlcvStatus(error);
      // Public plan: older than ~180d → 401. Stop; keep what we have.
      if (status === 401 || status === 404) break;
      if (status === 429) break;
      throw error;
    }
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Highest daily high from the pinned pool (~180d on the public API). */
export async function getPoolAthUsd(pairAddress: string | null | undefined): Promise<number | null> {
  if (!pairAddress || !isHexPool(pairAddress)) return null;
  try {
    const days = await fetchDayHistory(pairAddress);
    if (!days.length) return null;
    const ath = Math.max(...days.map((c) => c.high));
    return Number.isFinite(ath) && ath > 0 ? ath : null;
  } catch {
    return null;
  }
}

/** At most one warm-up in flight per pool. Preferred series loads first for fast /chart. */
async function loadSeriesPack(pool: string, prefer?: ChartWindow): Promise<SeriesPack> {
  const key = pool.toLowerCase();
  const preferField = prefer ? WINDOW_PLAN[prefer].field : "hour";
  const hit = seriesPackCache.get(key);
  if (hit && hit[preferField].length >= 2) {
    const age = Date.now() - hit.at;
    if (age < SERIES_CACHE_MS || (Date.now() < geckoCooldownUntil && age < STALE_SERIES_MS)) {
      return hit;
    }
  }

  const inflight = seriesPackInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<SeriesPack> => {
    const pack: SeriesPack = {
      at: hit?.at ?? Date.now(),
      fine: hit?.fine ?? [],
      mid: hit?.mid ?? [],
      hour: hit?.hour ?? [],
      day: hit?.day ?? [],
    };

    const loadField = async (field: keyof Omit<SeriesPack, "at">): Promise<void> => {
      if (pack[field].length >= 2) return;
      if (Date.now() < geckoCooldownUntil) return;
      try {
        if (field === "day") {
          const days = await fetchDayHistory(pool);
          if (days.length) pack.day = days;
          return;
        }
        const map = {
          fine: { unit: "minute" as const, agg: 5, limit: 90, empty: false },
          mid: { unit: "minute" as const, agg: 15, limit: 120, empty: true },
          hour: { unit: "hour" as const, agg: 1, limit: 200, empty: true },
        }[field];
        if (!map) return;
        const candles = await tryOhlcv(pool, map.unit, map.agg, map.limit, {
          includeEmpty: map.empty,
        });
        if (candles.length) pack[field] = candles;
      } catch {
        // leave empty; caller may fall back
      }
    };

    // Fast path: only what this window needs, then return.
    await loadField(preferField);
    if (preferField === "hour" && pack.hour.length < 2) await loadField("mid");
    if (preferField === "mid" && pack.mid.length < 2) await loadField("hour");
    if (preferField === "day" && pack.day.length < 2) await loadField("hour");

    cacheSeriesPack(key, pack, hit);
    if (!seriesPackHasData(pack) && hit && seriesPackHasData(hit)) return hit;

    // Warm remaining series in the background (don't block the chart).
    void (async () => {
      for (const field of ["hour", "mid", "day", "fine"] as const) {
        if (field === preferField) continue;
        await loadField(field);
        cacheSeriesPack(key, pack, hit);
      }
    })();

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
  const plan = WINDOW_PLAN[window];
  const fallbacks: Array<{ field: keyof Omit<SeriesPack, "at">; label: string; intervalSec: number }> = [
    plan,
    { field: "hour", label: "1h", intervalSec: 60 * 60 },
    { field: "mid", label: "15m", intervalSec: 15 * 60 },
    { field: "fine", label: "5m", intervalSec: 5 * 60 },
    { field: "day", label: "1d", intervalSec: 24 * 60 * 60 },
  ];

  for (const choice of fallbacks) {
    const series = pack[choice.field];
    if (!series.length) continue;
    const traded = filterByWindow(series, window);
    const source = traded.length ? traded : series.slice(-1);
    const padded = padEmptyBuckets(source, series, choice.intervalSec, window);
    if (padded.length >= 2) {
      return { candles: padded, intervalLabel: choice.label };
    }
  }

  return { candles: [], intervalLabel: plan.label };
}

export interface OhlcvResult {
  candles: Candle[];
  intervalLabel: string;
  window: ChartWindow;
}

/** Buy-card chart: last 24h, prefer hourly bars for even spacing. */
export async function getOhlcvForBuyCard(
  pairAddress: string | null | undefined,
): Promise<{ candles: Candle[]; intervalLabel: string }> {
  if (!pairAddress || !isHexPool(pairAddress)) {
    return { candles: [], intervalLabel: "1h" };
  }

  const key = `${pairAddress.toLowerCase()}:buycard`;
  const hit = ohlcvCache.get(key);
  if (hit && Date.now() - hit.at < BUYCARD_CACHE_MS) {
    return { candles: hit.candles, intervalLabel: hit.label };
  }

  try {
    const pack = await loadSeriesPack(pairAddress, "1d");
    const cutoff = Math.floor((Date.now() - 24 * 3_600_000) / 1000);
    const hasVolume = (c: Candle) => (c.volume ?? 0) > 0;
    const inWindow = (c: Candle) => candleSec(c) >= cutoff;

    let series = pack.hour.filter(inWindow).filter(hasVolume);
    let label = "1h";
    if (series.length < 4) {
      series = pack.mid.filter(inWindow).filter(hasVolume);
      label = "15m";
    }
    if (series.length < 4) {
      series = pack.hour.filter(hasVolume).slice(-24);
      label = "1h";
    }
    if (series.length < 2) {
      series = pack.mid.filter(hasVolume).slice(-32);
      label = "15m";
    }

    const candles = series.slice(-24);
    ohlcvCache.set(key, { at: Date.now(), candles, label });
    return { candles, intervalLabel: label };
  } catch {
    ohlcvCache.set(key, { at: Date.now(), candles: [], label: "1h" });
    return { candles: [], intervalLabel: "1h" };
  }
}

/** @deprecated Use getOhlcvForBuyCard */
export async function getOhlcv(pairAddress: string | null | undefined): Promise<Candle[]> {
  const { candles } = await getOhlcvForBuyCard(pairAddress);
  return candles;
}

export async function getOhlcvForWindow(
  pairAddress: string | null | undefined,
  window: ChartWindow = DEFAULT_CHART_WINDOW,
): Promise<OhlcvResult> {
  if (!pairAddress || !isHexPool(pairAddress)) {
    return { candles: [], intervalLabel: "1h", window };
  }

  const pack = await loadSeriesPack(pairAddress, window);
  const picked = pickSeriesForWindow(pack, window);
  return { ...picked, window };
}
