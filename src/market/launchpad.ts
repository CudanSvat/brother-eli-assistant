import { config } from "../config.ts";
import { compactAddress, fetchJson, normalizeAddress, addressesEqual } from "../lib/format.ts";

const CACHE_MS = 20_000;
const cache = new Map<string, { at: number; value: LaunchpadToken | null }>();

export interface LaunchpadToken {
  address: string;
  name: string;
  symbol: string;
  logo: string | null;
  description: string | null;
  pair: string | null;
  graduated: boolean;
  listed: boolean;
  priceUsd: number | null;
  marketCap: number | null;
  volumeUsd: number | null;
  change24h: number | null;
  holders: number | null;
  createdAt: string | null;
}

interface LaunchpadTokenRow {
  address?: string;
  name?: string;
  symbol?: string;
  logo?: string | null;
  description?: string | null;
  pair?: string | null;
  graduated?: boolean;
  listed?: boolean;
  priceUsd?: number | null;
  mcapUsd?: number | null;
  volumeUsd?: number | null;
  change?: number | null;
  holders?: number | null;
  createdAt?: string | null;
}

interface TokensResponse {
  total?: number;
  rows?: LaunchpadTokenRow[];
}

function launchpadOrigin(): string {
  return `${config.eliSiteOrigin}/launchpad`;
}

export function launchpadTokenUrl(address: string): string {
  return `${launchpadOrigin()}/token/${compactAddress(address)}`;
}

export function launchpadHomeUrl(): string {
  return launchpadOrigin();
}

/** Resolve logo paths like `/tokens/slay.png` against the launchpad origin. */
export function resolveLaunchpadLogo(logo: string | null | undefined): string | null {
  if (!logo?.trim()) return null;
  const raw = logo.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${launchpadOrigin()}${raw}`;
  return `${launchpadOrigin()}/${raw}`;
}

function mapRow(row: LaunchpadTokenRow): LaunchpadToken | null {
  if (!row.address) return null;
  return {
    address: normalizeAddress(row.address),
    name: row.name?.trim() || row.symbol?.trim() || "Token",
    symbol: row.symbol?.trim() || "TOKEN",
    logo: resolveLaunchpadLogo(row.logo),
    description: row.description?.trim() || null,
    pair: row.pair ?? null,
    graduated: Boolean(row.graduated),
    listed: Boolean(row.listed),
    priceUsd: num(row.priceUsd),
    marketCap: num(row.mcapUsd),
    volumeUsd: num(row.volumeUsd),
    change24h: num(row.change),
    holders: num(row.holders),
    createdAt: row.createdAt ?? null,
  };
}

function num(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function pickBest(rows: LaunchpadToken[], query: string): LaunchpadToken | null {
  if (!rows.length) return null;
  const q = query.trim().toLowerCase().replace(/^\$/, "");
  if (/^0x[0-9a-f]+$/i.test(q)) {
    const byAddr = rows.find((r) => addressesEqual(r.address, q));
    if (byAddr) return byAddr;
  }
  return (
    rows.find((r) => r.symbol.toLowerCase() === q) ??
    rows.find((r) => r.name.toLowerCase() === q) ??
    rows.find((r) => r.symbol.toLowerCase().startsWith(q)) ??
    rows[0] ??
    null
  );
}

async function fetchTokens(q: string): Promise<LaunchpadToken[]> {
  const url = `${launchpadOrigin()}/api/tokens?q=${encodeURIComponent(q)}`;
  const body = await fetchJson<TokensResponse>(url, 10_000, {
    accept: "application/json",
    "User-Agent": "BrotherEliAssistant/1",
  });
  return (body.rows ?? []).map(mapRow).filter((t): t is LaunchpadToken => Boolean(t));
}

/** Lookup a launchpad coin by contract address (canonical). */
export async function getLaunchpadTokenByAddress(address: string): Promise<LaunchpadToken | null> {
  const key = normalizeAddress(address);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  try {
    const rows = await fetchTokens(compactAddress(key));
    const exact = rows.find((r) => addressesEqual(r.address, key)) ?? null;
    cache.set(key, { at: Date.now(), value: exact });
    return exact;
  } catch (error) {
    console.warn("Launchpad token lookup failed:", error);
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
}

/** Search launchpad discover by symbol / name / address. */
export async function searchLaunchpadToken(query: string): Promise<LaunchpadToken | null> {
  const q = query.trim();
  if (!q) return null;
  const cacheKey = `q:${q.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  try {
    const rows = await fetchTokens(q);
    const best = pickBest(rows, q);
    cache.set(cacheKey, { at: Date.now(), value: best });
    if (best) cache.set(best.address, { at: Date.now(), value: best });
    return best;
  } catch (error) {
    console.warn("Launchpad search failed:", error);
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}
