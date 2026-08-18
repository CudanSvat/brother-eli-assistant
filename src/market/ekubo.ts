import { fetchJson, normalizeAddress } from "../lib/format.ts";

interface EkuboToken {
  name?: string;
  symbol?: string;
  decimals?: number;
  l2_token_address?: string;
  address?: string;
}

interface EkuboTokensResponse {
  tokens?: EkuboToken[];
}

const cache = new Map<string, EkuboToken | null>();

export async function getEkuboToken(address: string): Promise<{
  name: string;
  symbol: string;
  decimals: number;
} | null> {
  const token = normalizeAddress(address);
  if (cache.has(token)) {
    const hit = cache.get(token);
    if (!hit) return null;
    return {
      name: hit.name || hit.symbol || "Unknown",
      symbol: hit.symbol || "TOKEN",
      decimals: hit.decimals ?? 18,
    };
  }

  try {
    const body = await fetchJson<EkuboTokensResponse>(
      `https://prod-api.ekubo.org/tokens?chainId=SN_MAIN`,
    );
    for (const item of body.tokens ?? []) {
      const addr = item.l2_token_address || item.address;
      if (!addr) continue;
      cache.set(normalizeAddress(addr), item);
    }
    if (!cache.has(token)) cache.set(token, null);
    const hit = cache.get(token);
    if (!hit) return null;
    return {
      name: hit.name || hit.symbol || "Unknown",
      symbol: hit.symbol || "TOKEN",
      decimals: hit.decimals ?? 18,
    };
  } catch (error) {
    console.warn("Ekubo token list failed:", error);
    cache.set(token, null);
    return null;
  }
}

export function ekuboSwapUrl(tokenAddress: string): string {
  return `https://app.ekubo.org/?outputCurrency=${normalizeAddress(tokenAddress)}`;
}

export function avnuSwapUrl(tokenAddress: string): string {
  return `https://app.avnu.fi/en?tokenTo=${normalizeAddress(tokenAddress)}`;
}

export function starkscanTxUrl(hash: string): string {
  return `https://starkscan.co/tx/${hash}`;
}

export function starkscanAddressUrl(address: string): string {
  return `https://starkscan.co/contract/${normalizeAddress(address)}`;
}
