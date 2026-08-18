import { QUOTE_TOKENS } from "../config.ts";

const FELT_MASK = (1n << 251n) - 1n;

export function normalizeAddress(value: string): string {
  let hex = value.trim().toLowerCase();
  if (hex.startsWith("0x")) hex = hex.slice(2);
  hex = hex.replace(/^0+/, "") || "0";
  return `0x${hex.padStart(64, "0")}`;
}

export function isStarknetAddress(value: string): boolean {
  const hex = value.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(hex)) return false;
  try {
    return BigInt(hex) <= FELT_MASK;
  } catch {
    return false;
  }
}

export function addressesEqual(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}

export function shortAddress(address: string): string {
  const n = normalizeAddress(address);
  return `${n.slice(0, 6)}…${n.slice(-4)}`;
}

/** Unpadded 0x… form used by ekubo.org swap links. */
export function compactAddress(address: string): string {
  const hex = normalizeAddress(address).slice(2).replace(/^0+/, "") || "0";
  return `0x${hex}`;
}

export function feltToBigInt(value: string | bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
}

export function parseI129(mag: bigint, sign: bigint): bigint {
  return sign === 0n ? mag : -mag;
}

export function isQuoteToken(address: string): boolean {
  return Boolean(QUOTE_TOKENS[normalizeAddress(address)]);
}

export function quoteMeta(address: string): { symbol: string; decimals: number } {
  return (
    QUOTE_TOKENS[normalizeAddress(address)] ?? {
      symbol: shortAddress(address),
      decimals: 18,
    }
  );
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.0001) return `$${value.toFixed(4)}`;
  return `$${value.toExponential(2)}`;
}

export function formatTokenAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  if (abs >= 1) return amount.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return amount.toPrecision(4);
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function toUnitAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export async function fetchJson<T>(url: string, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
