import type { RpcProvider } from "starknet";
import { BURN_ADDRESS } from "../config.ts";
import { normalizeAddress } from "../lib/format.ts";

/** Format a whole-token burn amount for captions / card (e.g. `242.8k`). */
export function formatBurnAmount(units: number): string {
  if (!Number.isFinite(units) || units <= 0) return "—";
  const abs = Math.abs(units);
  if (abs >= 1_000_000_000) return `${(units / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(units / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(units / 1_000).toFixed(1)}k`;
  if (abs >= 1) return units.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return units.toPrecision(3);
}

/**
 * Live burned supply = ERC-20 balance of the launchpad burn address (`0x…dEaD`).
 * Same source the launchpad indexer rolls into `token_stats.burned`.
 */
export async function getBurnedRaw(
  provider: RpcProvider,
  tokenAddress: string,
): Promise<bigint> {
  const token = normalizeAddress(tokenAddress);
  const burn = normalizeAddress(BURN_ADDRESS);
  try {
    const result = await provider.callContract({
      contractAddress: token,
      entrypoint: "balance_of",
      calldata: [burn],
    });
    const low = BigInt(result[0] ?? "0");
    const high = BigInt(result[1] ?? "0");
    return low + (high << 128n);
  } catch (error) {
    console.warn("Burn balance read failed:", error);
    return 0n;
  }
}

export function rawToUnits(raw: bigint, decimals = 18): number {
  if (raw <= 0n) return 0;
  return Number(raw) / 10 ** decimals;
}
