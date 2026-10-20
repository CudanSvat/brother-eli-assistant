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

/**
 * Cairo `ByteArray` return: [data_len, ...31-byte words, pending_word, pending_len].
 * Older ERC-20s return a single felt252 short-string instead.
 */
function decodeFeltOrByteArray(result: string[]): string | null {
  if (!result.length) return null;

  if (result.length >= 3) {
    try {
      const dataLen = Number(BigInt(result[0]!));
      if (Number.isFinite(dataLen) && dataLen >= 0 && result.length === dataLen + 3) {
        const parts: Buffer[] = [];
        let i = 1;
        for (let w = 0; w < dataLen; w++) {
          const word = BigInt(result[i++]!);
          parts.push(Buffer.from(word.toString(16).padStart(62, "0"), "hex"));
        }
        const pending = BigInt(result[i++]!);
        const pendingLen = Number(BigInt(result[i++]!));
        if (Number.isFinite(pendingLen) && pendingLen > 0 && pendingLen <= 31) {
          const hex = pending.toString(16).padStart(pendingLen * 2, "0");
          parts.push(Buffer.from(hex.slice(-pendingLen * 2), "hex"));
        }
        const text = Buffer.concat(parts).toString("utf8").replaceAll("\0", "").trim();
        if (text) return text;
      }
    } catch {
      // fall through to felt252
    }
  }

  if (result.length === 1) {
    const text = feltToAscii(result[0]!);
    return text || null;
  }
  return null;
}

async function callView(
  provider: RpcProvider,
  address: string,
  entrypoint: string,
): Promise<string[] | null> {
  try {
    const result = await provider.callContract({
      contractAddress: address,
      entrypoint,
      calldata: [],
    });
    return result.map(String);
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
    const raw = await callView(provider, address, "symbol");
    if (raw) symbol = decodeFeltOrByteArray(raw) ?? undefined;
  }
  if (!name) {
    const raw = await callView(provider, address, "name");
    if (raw) name = decodeFeltOrByteArray(raw) ?? undefined;
  }
  if (decimals == null) {
    const raw = await callView(provider, address, "decimals");
    if (raw?.[0]) decimals = Number(BigInt(raw[0]));
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
