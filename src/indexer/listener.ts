import { RpcProvider, WebSocketChannel } from "starknet";
import { config, EKUBO_CORE, SWAPPED_SELECTOR } from "../config.ts";
import { allTrackedAddresses, getMeta, setMeta } from "../store/db.ts";
import { decodeSwapped } from "./decode.ts";
import { netTransaction } from "./classify.ts";
import { normalizeAddress, addressesEqual, sleep } from "../lib/format.ts";
import { createFailoverFetch } from "../lib/rpc.ts";
import type { ClassifiedSwap, DecodedSwap } from "../types.ts";

export type SwapHandler = (swap: ClassifiedSwap) => void | Promise<void>;

interface PendingTx {
  hops: DecodedSwap[];
  timer: ReturnType<typeof setTimeout>;
}

function unwrapEvent(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  const nested = (root.result ?? root.event ?? root) as Record<string, unknown>;
  if (!nested || typeof nested !== "object") return root;
  return { ...root, ...nested };
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function swappedSelectorHex(): string {
  return normalizeAddress(`0x${BigInt(SWAPPED_SELECTOR).toString(16)}`);
}

export class EkuboListener {
  private readonly pending = new Map<string, PendingTx>();
  private lastBlock = 0;
  private running = false;
  private seen = new Set<string>();
  private flushed = new Set<string>();
  /** While true, hop timers are deferred so pagination can't flush mid-tx. */
  private polling = false;
  private readonly swappedKey = swappedSelectorHex();
  private readonly ekubo = normalizeAddress(EKUBO_CORE);

  constructor(
    private readonly http: RpcProvider,
    private readonly onSwap: SwapHandler,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    const latest = await this.http.getBlockNumber();
    const saved = Number(getMeta("last_block"));
    this.lastBlock =
      Number.isFinite(saved) && saved > 0 ? Math.min(saved, latest) : Math.max(0, latest - 2);
    console.log(`Indexer starting at block ${this.lastBlock} (latest ${latest})`);

    if (config.wsUrl) {
      this.startWebsocket().catch((error) => {
        console.warn("WebSocket indexer failed, using HTTP poll:", error);
      });
    }
    this.pollLoop().catch((error) => {
      console.error("HTTP poll loop crashed:", error);
    });
  }

  stop(): void {
    this.running = false;
  }

  private async startWebsocket(): Promise<void> {
    const channel = new WebSocketChannel({
      nodeUrl: config.wsUrl,
      autoReconnect: true,
    });
    await channel.waitForConnection();
    console.log("Subscribed to Ekubo Swapped via WebSocket");

    const sub = await channel.subscribeEvents({
      fromAddress: EKUBO_CORE,
      keys: [[SWAPPED_SELECTOR]],
      finalityStatus: "ACCEPTED_ON_L2",
    });

    sub.on((payload) => {
      try {
        this.handleRawEvent(unwrapEvent(payload));
      } catch (error) {
        console.warn("Failed to handle WS event:", error);
      }
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.warn("getEvents poll failed:", error);
      }
      await sleep(config.pollIntervalMs);
    }
  }

  private async pollOnce(): Promise<void> {
    const latest = await this.http.getBlockNumber();
    if (latest <= this.lastBlock) return;
    const from = this.lastBlock + 1;
    const to = latest;
    let continuationToken: string | undefined;

    this.polling = true;
    try {
      do {
        const page = await this.http.getEvents({
          address: EKUBO_CORE,
          keys: [[SWAPPED_SELECTOR]],
          from_block: { block_number: from },
          to_block: { block_number: to },
          chunk_size: 100,
          continuation_token: continuationToken,
        });
        for (const event of page.events) {
          this.handleRawEvent(unwrapEvent(event));
        }
        continuationToken = page.continuation_token;
      } while (continuationToken);
    } finally {
      this.polling = false;
      this.armAllPending();
    }

    this.lastBlock = to;
    setMeta("last_block", String(to));
  }

  private handleRawEvent(raw: Record<string, unknown>): void {
    const keys = asStringArray(raw.keys);
    const data = asStringArray(raw.data);
    const transactionHash = String(raw.transaction_hash ?? raw.transactionHash ?? "");
    if (!transactionHash || !data?.length) return;

    const blockNumber = Number(raw.block_number ?? raw.blockNumber ?? 0);
    const eventIndex = String(raw.event_index ?? raw.eventIndex ?? "");
    const dedupe = `${transactionHash}:${eventIndex}:${data[0]}:${data.length}`;
    if (this.seen.has(dedupe)) return;
    this.seen.add(dedupe);
    if (this.seen.size > 20_000) {
      this.seen = new Set([...this.seen].slice(-8_000));
    }

    const decoded = decodeSwapped({
      keys,
      data,
      transaction_hash: transactionHash,
      block_number: blockNumber,
    });
    this.queueHop(decoded);
  }

  private queueHop(swap: DecodedSwap): void {
    const key = normalizeAddress(swap.transactionHash);
    if (this.flushed.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) {
      existing.hops.push(swap);
      clearTimeout(existing.timer);
      existing.timer = this.armFlush(key);
      return;
    }
    this.pending.set(key, { hops: [swap], timer: this.armFlush(key) });
  }

  private armAllPending(): void {
    for (const key of this.pending.keys()) {
      const entry = this.pending.get(key);
      if (!entry) continue;
      clearTimeout(entry.timer);
      entry.timer = this.armFlush(key);
    }
  }

  private armFlush(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.polling) {
        // Still paginating — try again after the quiet window.
        const entry = this.pending.get(key);
        if (entry) entry.timer = this.armFlush(key);
        return;
      }
      const entry = this.pending.get(key);
      this.pending.delete(key);
      if (!entry) return;
      this.flush(key, entry.hops).catch((error) => console.warn("Flush failed:", error));
    }, config.hopFlushMs);
  }

  /**
   * Prefer the full tx receipt so AVNU multi-hop routes aren't valued from a
   * partial hop set (HTTP pagination / WS can deliver hops seconds apart).
   */
  async hopsFromReceipt(txHash: string, fallback: DecodedSwap[]): Promise<DecodedSwap[]> {
    try {
      const receipt = await this.http.getTransactionReceipt(txHash);
      const events = (receipt as { events?: Array<Record<string, unknown>> }).events ?? [];
      const hops: DecodedSwap[] = [];
      const blockNumber =
        Number((receipt as { block_number?: number }).block_number ?? fallback[0]?.blockNumber ?? 0);
      for (const ev of events) {
        const from = String(ev.from_address ?? ev.fromAddress ?? "");
        if (!addressesEqual(from, this.ekubo)) continue;
        const keys = asStringArray(ev.keys) ?? [];
        if (!keys.length || normalizeAddress(keys[0]!) !== this.swappedKey) continue;
        const data = asStringArray(ev.data);
        if (!data?.length) continue;
        hops.push(
          decodeSwapped({
            keys,
            data,
            transaction_hash: txHash,
            block_number: blockNumber,
          }),
        );
      }
      if (hops.length >= fallback.length) return hops;
    } catch (error) {
      console.warn(`Receipt enrich failed for ${txHash}:`, error);
    }
    return fallback;
  }

  private async flush(txHash: string, buffered: DecodedSwap[]): Promise<void> {
    const key = normalizeAddress(txHash);
    if (this.flushed.has(key)) return;
    this.flushed.add(key);
    if (this.flushed.size > 8_000) {
      this.flushed = new Set([...this.flushed].slice(-4_000));
    }

    const hops = await this.hopsFromReceipt(txHash, buffered);
    const tracked = allTrackedAddresses();
    if (!tracked.length) return;

    for (const token of tracked) {
      const merged = netTransaction(hops, token);
      if (!merged) continue;
      console.log(
        `Ekubo ${merged.side} ${token} hops=${merged.hopCount} (buf=${buffered.length}) block=${merged.blockNumber} tx=${merged.transactionHash}`,
      );
      await this.onSwap(merged);
    }
  }
}

export function createProvider(): RpcProvider {
  const urls = config.rpcUrls;
  if (urls.length > 1) {
    console.log(`RPC failover: ${urls.length} endpoints`);
  }
  return new RpcProvider({
    nodeUrl: urls[0]!,
    baseFetch: createFailoverFetch(urls),
  });
}

export { normalizeAddress };
