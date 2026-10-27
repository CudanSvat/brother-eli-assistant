import { hash, type RpcProvider } from "starknet";
import {
  BURN_ADDRESS,
  BURN_DIGEST_MIN,
  BURN_DIGEST_MS,
  DEGENZ_TOKEN,
  config,
} from "../config.ts";
import { addressesEqual, normalizeAddress, sleep } from "../lib/format.ts";
import { getBurnedRaw } from "../market/burn.ts";
import { getMeta, setMeta } from "../store/db.ts";

/**
 * Burn watch config — DEGENZ for now.
 * Later: per-token menu settings (digest interval, min size) can replace this.
 */
export interface BurnWatch {
  tokenAddress: string;
  symbol: string;
  decimals: number;
  digestMs: number;
  /** Minimum newly burned whole tokens before a digest posts. */
  minUnits: number;
}

export const DEGENZ_BURN_WATCH: BurnWatch = {
  tokenAddress: DEGENZ_TOKEN,
  symbol: "DEGENZ",
  decimals: 18,
  digestMs: BURN_DIGEST_MS,
  minUnits: BURN_DIGEST_MIN,
};

export interface BurnDigestEvent {
  watch: BurnWatch;
  /** Tokens burned in this digest window (raw). */
  amountRaw: bigint;
  burnCount: number;
  /** Cumulative balance at the burn address after this window. */
  totalBurnedRaw: bigint;
}

export type BurnDigestHandler = (event: BurnDigestEvent) => Promise<void>;

interface DigestState {
  lastBlock: number;
  pendingRaw: string;
  pendingCount: number;
  lastFlushAt: number;
}

const TRANSFER_SELECTOR = hash.getSelectorFromName("Transfer");
const META_PREFIX = "burn_digest:";

function metaKey(token: string): string {
  return `${META_PREFIX}${normalizeAddress(token)}`;
}

function loadState(token: string): DigestState | null {
  const raw = getMeta(metaKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DigestState;
    if (
      typeof parsed.lastBlock === "number" &&
      typeof parsed.pendingRaw === "string" &&
      typeof parsed.pendingCount === "number" &&
      typeof parsed.lastFlushAt === "number"
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveState(token: string, state: DigestState): void {
  setMeta(metaKey(token), JSON.stringify(state));
}

function u256(data: string[] | undefined): bigint {
  if (!data?.length) return 0n;
  const low = BigInt(data[0] ?? "0");
  const high = BigInt(data[1] ?? "0");
  return low + (high << 128n);
}

/**
 * Poll ERC-20 Transfer → burn address for watched tokens.
 * Accumulates burns and fires an hourly (configurable) digest instead of per-tx spam.
 */
export async function startBurnDigestPoller(
  provider: RpcProvider,
  onDigest: BurnDigestHandler,
  watches: BurnWatch[] = [DEGENZ_BURN_WATCH],
): Promise<void> {
  const burn = normalizeAddress(BURN_ADDRESS);
  const pollMs = Math.max(15_000, config.pollBackupMs);

  for (const watch of watches) {
    const latest = await provider.getBlockNumber();
    let state = loadState(watch.tokenAddress);
    if (!state) {
      // First run: don't replay history — start clean from tip.
      state = {
        lastBlock: latest,
        pendingRaw: "0",
        pendingCount: 0,
        lastFlushAt: Date.now(),
      };
      saveState(watch.tokenAddress, state);
      console.log(
        `Burn digest watching ${watch.symbol} from block ${latest} (flush every ${Math.round(watch.digestMs / 60_000)}m)`,
      );
    }
  }

  const loop = async (): Promise<void> => {
    while (true) {
      try {
        for (const watch of watches) {
          await pollWatch(provider, watch, burn, onDigest);
        }
      } catch (error) {
        console.warn("Burn digest poll failed:", error);
      }
      await sleep(pollMs);
    }
  };

  void loop();
}

async function pollWatch(
  provider: RpcProvider,
  watch: BurnWatch,
  burn: string,
  onDigest: BurnDigestHandler,
): Promise<void> {
  const latest = await provider.getBlockNumber();
  let state = loadState(watch.tokenAddress) ?? {
    lastBlock: latest,
    pendingRaw: "0",
    pendingCount: 0,
    lastFlushAt: Date.now(),
  };

  if (latest > state.lastBlock) {
    const from = state.lastBlock + 1;
    const to = latest;
    let continuationToken: string | undefined;
    let pending = BigInt(state.pendingRaw || "0");
    let count = state.pendingCount;

    do {
      const page = await provider.getEvents({
        address: normalizeAddress(watch.tokenAddress),
        // Transfer(from, to, …) — only burns to 0x…dEaD
        keys: [[TRANSFER_SELECTOR], [], [burn]],
        from_block: { block_number: from },
        to_block: { block_number: to },
        chunk_size: 100,
        continuation_token: continuationToken,
      });

      for (const event of page.events) {
        const keys = (event.keys ?? []).map(String);
        const data = (event.data ?? []).map(String);
        if (keys.length < 3) continue;
        if (!addressesEqual(keys[2]!, burn)) continue;
        const value = u256(data);
        if (value <= 0n) continue;
        pending += value;
        count += 1;
      }
      continuationToken = page.continuation_token;
    } while (continuationToken);

    state = {
      ...state,
      lastBlock: to,
      pendingRaw: pending.toString(),
      pendingCount: count,
    };
    saveState(watch.tokenAddress, state);
  }

  const due = Date.now() - state.lastFlushAt >= watch.digestMs;
  const pending = BigInt(state.pendingRaw || "0");
  if (!due || pending <= 0n) return;

  // Skip tiny windows — keep accumulating until the new burn amount clears the floor.
  const minRaw = BigInt(Math.floor(watch.minUnits)) * 10n ** BigInt(watch.decimals);
  if (pending < minRaw) return;

  const totalBurnedRaw = await getBurnedRaw(provider, watch.tokenAddress);

  const amountRaw = pending;
  const burnCount = state.pendingCount;
  state = {
    ...state,
    pendingRaw: "0",
    pendingCount: 0,
    lastFlushAt: Date.now(),
  };
  saveState(watch.tokenAddress, state);

  try {
    await onDigest({
      watch,
      amountRaw,
      burnCount,
      totalBurnedRaw,
    });
  } catch (error) {
    // Put pending back so we retry next hour.
    console.warn("Burn digest handler failed, re-queuing pending:", error);
    const again = loadState(watch.tokenAddress) ?? state;
    saveState(watch.tokenAddress, {
      ...again,
      pendingRaw: (BigInt(again.pendingRaw || "0") + amountRaw).toString(),
      pendingCount: again.pendingCount + burnCount,
      lastFlushAt: Date.now() - watch.digestMs, // retry soon
    });
  }
}
