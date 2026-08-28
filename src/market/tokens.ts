import { RpcProvider, num } from "starknet";
import { getEkuboToken } from "./ekubo.ts";
import {
  getMarketSnapshot,
  parsePoolUrl,
  parseTokenUrl,
  resolveChartPair,
  resolveGeckoPool,
} from "./geckoterminal.ts";
import { isStarknetAddress, normalizeAddress } from "../lib/format.ts";

const ERC20_ABI = [
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ type: "core::felt252" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ type: "core::integer::u8" }],
    state_mutability: "view",
  },
] as const;

type ResolvedToken = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  pairAddress: string | null;
  quoteAddress: string | null;
};

function feltToAscii(value: string): string {
  const hex = num.toHex(value).replace(/^0x/, "");
  const bytes = Buffer.from(hex.padStart(hex.length + (hex.length % 2), "0"), "hex");
  return [...bytes]
    .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ""))
    .join("")
    .replaceAll("\0", "")
    .trim();
}

async function callFelt(
  provider: RpcProvider,
  address: string,
  entrypoint: string,
): Promise<string | null> {
  try {
    const result = await provider.callContract({
      contractAddress: address,
      entrypoint,
      calldata: [],
    });
    return result[0] ?? null;
  } catch {
    return null;
  }
}

async function resolveTokenByAddress(
  provider: RpcProvider,
  rawAddress: string,
  pinnedPool?: string | null,
): Promise<ResolvedToken | null> {
  if (!isStarknetAddress(rawAddress)) return null;
  const address = normalizeAddress(rawAddress);

  const ekubo = await getEkuboToken(address);
  const market = await getMarketSnapshot(address, pinnedPool);

  let symbol = ekubo?.symbol;
  let name = ekubo?.name;
  let decimals = ekubo?.decimals;

  if (!symbol) {
    const felt = await callFelt(provider, address, "symbol");
    if (felt) symbol = feltToAscii(felt);
  }
  if (!name) {
    const felt = await callFelt(provider, address, "name");
    if (felt) name = feltToAscii(felt);
  }
  if (decimals == null) {
    const felt = await callFelt(provider, address, "decimals");
    if (felt) decimals = Number(BigInt(felt));
  }

  if (!symbol && !name) return null;

  return {
    address,
    symbol: (symbol || "TOKEN").slice(0, 20),
    name: name || symbol || "Unknown",
    decimals: Number.isFinite(decimals) ? Number(decimals) : 18,
    pairAddress: resolveChartPair(address, pinnedPool ?? market?.pairAddress ?? null),
    quoteAddress: null,
  };
}

async function resolveFromPool(provider: RpcProvider, pool: string): Promise<ResolvedToken | null> {
  const meta = await resolveGeckoPool(pool);
  if (!meta) return null;
  return resolveTokenByAddress(provider, meta.baseToken, meta.poolAddress);
}

export async function resolveToken(provider: RpcProvider, raw: string): Promise<ResolvedToken | null> {
  const urlPool = parsePoolUrl(raw);
  if (urlPool) return resolveFromPool(provider, urlPool);

  const urlToken = parseTokenUrl(raw);
  if (urlToken) return resolveTokenByAddress(provider, urlToken);

  const text = raw.trim();
  if (!isStarknetAddress(text)) return null;

  const asToken = await resolveTokenByAddress(provider, text);
  if (asToken) return asToken;

  return resolveFromPool(provider, text);
}

export { ERC20_ABI };
