import { compactAddress, fetchJson, normalizeAddress } from "../lib/format.ts";

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
    console.warn("Ekubo token list unavailable, using DexScreener/RPC");
    cache.set(token, null);
    return null;
  }
}

const ETH = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

export function ekuboSwapUrl(tokenAddress: string): string {
  const token = compactAddress(tokenAddress);
  const eth = compactAddress(ETH);
  return `https://ekubo.org/swap?outputCurrency=${token}&amount=1&inputCurrency=${eth}`;
}

export function avnuSwapUrl(tokenAddress: string, symbol?: string): string {
  const token = normalizeAddress(tokenAddress);
  const buy = (symbol || "token").toLowerCase().replace(/[^a-z0-9]/g, "") || "token";
  return `https://app.avnu.fi/en?tokenTo=${token}&sellToken=eth&buyToken=${buy}`;
}

export function starkscanTxUrl(hash: string): string {
  return `https://starkscan.co/tx/${hash}`;
}

export function starkscanAddressUrl(address: string): string {
  return `https://starkscan.co/contract/${normalizeAddress(address)}`;
}
