import { config, QUOTE_TOKENS, SLAY_TOKEN } from "../config.ts";
import { formatTokenAmount, normalizeAddress, quoteMeta, toUnitAmount } from "../lib/format.ts";

const FETCH_MS = 15_000;

export interface MarketplaceActivity {
  event: string;
  id?: string;
  token_id?: string;
  transaction_hash: string;
  block_number: number;
  event_index?: number;
  block_hash?: string;
  gross?: string;
  amount?: string;
  currency?: string;
  status?: number;
  mode?: number;
  price?: string;
  seller?: string;
  buyer?: string;
  sender?: string;
  owner?: string;
}

export interface MarketplaceSale {
  id: string;
  mode: number;
  status: number;
  currency: string;
  price: string;
  items?: { index: number; token_id: string }[];
}

export interface ActivityPage {
  items: MarketplaceActivity[];
  next_cursor?: string | null;
  resume_cursor?: string | null;
}

async function marketplaceGet<T>(path: string): Promise<T> {
  const url = `${config.marketplaceApiUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "BrotherEliAssistant/1" },
    signal: AbortSignal.timeout(FETCH_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Marketplace ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

export async function fetchActivityPage(opts: {
  limit?: number;
  cursor?: string | null;
  order?: "asc" | "desc";
}): Promise<ActivityPage> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 50));
  if (opts.order) params.set("order", opts.order);
  if (opts.cursor) params.set("cursor", opts.cursor);
  return marketplaceGet<ActivityPage>(`/activity?${params}`);
}

export async function fetchSale(id: string): Promise<MarketplaceSale | null> {
  try {
    return await marketplaceGet<MarketplaceSale>(`/sales/${encodeURIComponent(id)}`);
  } catch (error) {
    console.warn(`Marketplace sale ${id} fetch failed:`, error);
    return null;
  }
}

function currencyMeta(address: string): { symbol: string; decimals: number } {
  const n = normalizeAddress(address);
  if (n === normalizeAddress(SLAY_TOKEN)) return { symbol: "SLAY", decimals: 18 };
  if (QUOTE_TOKENS[n]) return QUOTE_TOKENS[n]!;
  return quoteMeta(address);
}

/** Format a marketplace amount (wei-style string) with its currency symbol. */
export function formatMarketplaceMoney(
  raw: string | undefined | null,
  currency: string | undefined | null,
): string | null {
  if (raw == null || raw === "" || !currency) return null;
  let amount: bigint;
  try {
    amount = BigInt(raw);
  } catch {
    return null;
  }
  if (amount < 0n) return null;
  const meta = currencyMeta(currency);
  const units = toUnitAmount(amount, meta.decimals);
  return `${formatTokenAmount(units)} ${meta.symbol}`;
}
