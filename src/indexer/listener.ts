import { RpcProvider, WebSocketChannel } from "starknet";
import { config, EKUBO_CORE, SWAPPED_SELECTOR } from "../config.ts";
import { allTrackedAddresses } from "../store/db.ts";
import { decodeSwapped } from "./decode.ts";
import { netTransaction } from "./classify.ts";
import { normalizeAddress, sleep } from "../lib/format.ts";
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

export class EkuboListener {
  private readonly pending = new Map<string, PendingTx>();
  private lastBlock = 0;
  private running = false;
  private seen = new Set<string>();

  constructor(
    private readonly http: RpcProvider,
    private readonly onSwap: SwapHandler,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    const latest = await this.http.getBlockNumber();
    this.lastBlock = Math.max(0, latest - 30);
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

    this.lastBlock = to;
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
    const key = swap.transactionHash;
    const existing = this.pending.get(key);
    if (existing) {
      existing.hops.push(swap);
      clearTimeout(existing.timer);
      existing.timer = this.armFlush(key, existing.hops);
      return;
    }
    const hops = [swap];
    this.pending.set(key, { hops, timer: this.armFlush(key, hops) });
  }

  private armFlush(key: string, hops: DecodedSwap[]): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.pending.delete(key);
      this.flush(hops).catch((error) => console.warn("Flush failed:", error));
    }, config.hopFlushMs);
  }

  private async flush(hops: DecodedSwap[]): Promise<void> {
    const tracked = allTrackedAddresses();
    if (!tracked.length) return;

    for (const token of tracked) {
      const merged = netTransaction(hops, token);
      if (!merged) continue;
      console.log(
        `Ekubo ${merged.side} ${token} hops=${merged.hopCount} block=${merged.blockNumber} tx=${merged.transactionHash}`,
      );
      await this.onSwap(merged);
    }
  }
}

export function createProvider(): RpcProvider {
  return new RpcProvider({ nodeUrl: config.rpcUrl });
}

export { normalizeAddress };
