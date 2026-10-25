import type { RpcProvider } from "starknet";
import { ELI_COLLECTION } from "../config.ts";
import { ELI_MAX, ELI_MIN } from "../bot/eli-card.ts";
import { normalizeAddress } from "../lib/format.ts";
import { listEliHolders, replaceEliHolders, type EliHolderRow } from "../store/db.ts";

const ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const CONCURRENCY = 24;

async function ownerOf(
  provider: RpcProvider,
  tokenId: number,
): Promise<string | null> {
  try {
    const result = await provider.callContract({
      contractAddress: normalizeAddress(ELI_COLLECTION),
      entrypoint: "owner_of",
      calldata: [String(tokenId), "0"],
    });
    const raw = result[0];
    if (raw == null) return null;
    const addr = normalizeAddress(typeof raw === "string" ? raw : `0x${BigInt(raw).toString(16)}`);
    if (addr === ZERO) return null;
    return addr;
  } catch {
    return null;
  }
}

/** Refresh on-chain Eli owners (1…888) into SQLite. Returns cached rows. */
export async function refreshEliHolders(provider: RpcProvider): Promise<EliHolderRow[]> {
  const ids: number[] = [];
  for (let id = ELI_MIN; id <= ELI_MAX; id++) ids.push(id);

  const found: EliHolderRow[] = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const owners = await Promise.all(batch.map((id) => ownerOf(provider, id)));
    for (let j = 0; j < batch.length; j++) {
      const owner = owners[j];
      if (owner) found.push({ tokenId: batch[j]!, ownerAddress: owner });
    }
    if (i > 0 && i % (CONCURRENCY * 4) === 0) {
      console.log(`Wheel holders: scanned ${i}/${ids.length}, found ${found.length}`);
    }
  }

  if (found.length) {
    replaceEliHolders(found);
    console.log(`Wheel holders: cached ${found.length} Elis`);
    return found;
  }

  const cached = listEliHolders();
  if (cached.length) {
    console.warn(`Wheel holders: on-chain scan empty; using ${cached.length} cached`);
    return cached;
  }
  return [];
}

export function getCachedEliHolders(): EliHolderRow[] {
  return listEliHolders();
}
