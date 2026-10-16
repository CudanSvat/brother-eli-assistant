import { config } from "../config.ts";
import { getMeta, setMeta } from "../store/db.ts";
import {
  fetchActivityPage,
  fetchSale,
  formatMarketplaceMoney,
  type MarketplaceActivity,
} from "../market/marketplace.ts";
const META_READY = "nft_activity_ready";
const META_HIGHWATER = "nft_activity_highwater";
const META_SALE_STATUS = "nft_activity_sale_status";

export type NftAlertKind = "listed" | "auction_listed" | "sold" | "auction_sold";

export interface NftAlertEvent {
  kind: NftAlertKind;
  tokenId: number;
  transactionHash: string;
  eventIndex: number;
  blockNumber: number;
  saleId?: string;
  priceLabel: string | null;
  auction: boolean;
}

export type NftAlertHandler = (event: NftAlertEvent) => Promise<void>;

interface Highwater {
  block: number;
  tx: string;
  index: number;
}

function eventIndexOf(e: MarketplaceActivity): number {
  return e.event_index ?? 0;
}

function compareEvents(
  a: { block: number; tx: string; index: number },
  b: { block: number; tx: string; index: number },
): number {
  if (a.block !== b.block) return a.block - b.block;
  if (a.tx !== b.tx) return a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0;
  return a.index - b.index;
}

function isNewerThan(event: MarketplaceActivity, water: Highwater): boolean {
  return (
    compareEvents(
      {
        block: event.block_number,
        tx: event.transaction_hash,
        index: eventIndexOf(event),
      },
      water,
    ) > 0
  );
}

function loadHighwater(): Highwater | null {
  const raw = getMeta(META_HIGHWATER);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Highwater;
    if (
      typeof parsed.block === "number" &&
      typeof parsed.tx === "string" &&
      typeof parsed.index === "number"
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveHighwater(water: Highwater): void {
  setMeta(META_HIGHWATER, JSON.stringify(water));
}

function loadSaleStatus(): Map<string, number> {
  const map = new Map<string, number>();
  const raw = getMeta(META_SALE_STATUS);
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    for (const [id, status] of Object.entries(parsed)) {
      if (typeof status === "number") map.set(id, status);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function saveSaleStatus(map: Map<string, number>): void {
  const obj: Record<string, number> = {};
  // Keep a bounded window of recent sale ids.
  const entries = [...map.entries()].slice(-2_000);
  for (const [id, status] of entries) obj[id] = status;
  setMeta(META_SALE_STATUS, JSON.stringify(obj));
}

function parseTokenId(raw: string | undefined): number | null {
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > 888) return null;
  return id;
}

async function resolveSaleContext(event: MarketplaceActivity): Promise<{
  tokenIds: number[];
  auction: boolean;
}> {
  if (event.token_id && !event.id) {
    const id = parseTokenId(event.token_id);
    return {
      tokenIds: id != null ? [id] : [],
      auction: typeof event.mode === "number" ? event.mode === 1 : false,
    };
  }

  let tokenIds: number[] = [];
  if (event.token_id) {
    const id = parseTokenId(event.token_id);
    if (id != null) tokenIds = [id];
  }

  let auction = typeof event.mode === "number" ? event.mode === 1 : false;
  if (event.id && (!tokenIds.length || typeof event.mode !== "number")) {
    const sale = await fetchSale(event.id);
    if (!tokenIds.length) {
      tokenIds = (sale?.items ?? [])
        .map((item) => parseTokenId(item.token_id))
        .filter((id): id is number => id != null);
    }
    if (typeof event.mode !== "number") auction = sale?.mode === 1;
  }

  return { tokenIds, auction };
}

function priceFrom(event: MarketplaceActivity): string | null {
  const raw = event.gross ?? event.price ?? event.amount;
  return formatMarketplaceMoney(raw, event.currency);
}

function labelKind(base: "listed" | "sold", auction: boolean): NftAlertKind {
  if (base === "listed") return auction ? "auction_listed" : "listed";
  return auction ? "auction_sold" : "sold";
}

/**
 * Classify activity like brother-eli-slay simplifyActivity, but only listed/sold.
 * Mutates saleStatus for SaleUpdated transition tracking.
 */
async function classifyNewEvents(
  events: MarketplaceActivity[],
  saleStatus: Map<string, number>,
): Promise<NftAlertEvent[]> {
  const ordered = events
    .slice()
    .sort((a, b) =>
      compareEvents(
        { block: a.block_number, tx: a.transaction_hash, index: eventIndexOf(a) },
        { block: b.block_number, tx: b.transaction_hash, index: eventIndexOf(b) },
      ),
    );

  const out: NftAlertEvent[] = [];

  for (const e of ordered) {
    if (e.event === "Trade" && e.id) {
      const { tokenIds, auction } = await resolveSaleContext(e);
      const priceLabel = priceFrom(e);
      for (const tokenId of tokenIds) {
        out.push({
          kind: labelKind("sold", auction),
          tokenId,
          transactionHash: e.transaction_hash,
          eventIndex: eventIndexOf(e),
          blockNumber: e.block_number,
          saleId: e.id,
          priceLabel,
          auction,
        });
      }
      continue;
    }

    if (e.event === "TokenTrade" && e.token_id) {
      const tokenId = parseTokenId(e.token_id);
      if (tokenId == null) continue;
      out.push({
        kind: "sold",
        tokenId,
        transactionHash: e.transaction_hash,
        eventIndex: eventIndexOf(e),
        blockNumber: e.block_number,
        priceLabel: priceFrom(e),
        auction: false,
      });
      continue;
    }

    if (e.event === "SaleUpdated" && e.id) {
      const before = saleStatus.get(e.id);
      if (e.status !== undefined) saleStatus.set(e.id, e.status);
      if (e.status === 1 && before !== 1) {
        const { tokenIds, auction } = await resolveSaleContext(e);
        const priceLabel = priceFrom(e);
        for (const tokenId of tokenIds) {
          out.push({
            kind: labelKind("listed", auction),
            tokenId,
            transactionHash: e.transaction_hash,
            eventIndex: eventIndexOf(e),
            blockNumber: e.block_number,
            saleId: e.id,
            priceLabel,
            auction,
          });
        }
      }
    }
  }

  return out;
}

async function seedIfNeeded(saleStatus: Map<string, number>): Promise<Highwater | null> {
  if (getMeta(META_READY) === "1") return loadHighwater();

  console.log("NFT activity: seeding highwater (no historical posts)");
  const page = await fetchActivityPage({ limit: 200, order: "desc" });
  const items = page.items ?? [];

  // Warm sale-status map only (no posts, no sale fetches).
  const ordered = items
    .slice()
    .sort((a, b) =>
      compareEvents(
        { block: a.block_number, tx: a.transaction_hash, index: eventIndexOf(a) },
        { block: b.block_number, tx: b.transaction_hash, index: eventIndexOf(b) },
      ),
    );
  for (const e of ordered) {
    if (e.event === "SaleUpdated" && e.id && e.status !== undefined) {
      saleStatus.set(e.id, e.status);
    }
  }
  saveSaleStatus(saleStatus);

  if (!items.length) {
    setMeta(META_READY, "1");
    return null;
  }

  // Newest first from desc — first item is tip.
  const tip = items[0]!;
  const water: Highwater = {
    block: tip.block_number,
    tx: tip.transaction_hash,
    index: eventIndexOf(tip),
  };
  saveHighwater(water);
  setMeta(META_READY, "1");
  console.log(`NFT activity: seeded at block ${water.block}`);
  return water;
}

export async function startNftActivityPoller(onAlert: NftAlertHandler): Promise<void> {
  const saleStatus = loadSaleStatus();
  let water: Highwater | null = loadHighwater();
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      if (getMeta(META_READY) !== "1") {
        water = await seedIfNeeded(saleStatus);
      } else if (!water) {
        water = loadHighwater();
      }

      const page = await fetchActivityPage({ limit: 50, order: "desc" });
      const items = page.items ?? [];
      if (!items.length) return;

      const tip = items[0]!;
      const tipWater: Highwater = {
        block: tip.block_number,
        tx: tip.transaction_hash,
        index: eventIndexOf(tip),
      };

      // No highwater yet (empty seed): adopt tip without posting.
      if (!water) {
        water = tipWater;
        saveHighwater(water);
        return;
      }

      const fresh = items.filter((e) => isNewerThan(e, water!));
      if (!fresh.length) {
        if (compareEvents(tipWater, water) > 0) {
          water = tipWater;
          saveHighwater(water);
        }
        return;
      }

      const alerts = await classifyNewEvents(fresh, saleStatus);
      saveSaleStatus(saleStatus);

      for (const alert of alerts) {
        try {
          await onAlert(alert);
        } catch (error) {
          console.warn("NFT alert handler failed:", error);
        }
      }

      water = tipWater;
      saveHighwater(water);
    } catch (error) {
      console.warn("NFT activity poll failed:", error);
    } finally {
      busy = false;
    }
  };

  try {
    await tick();
  } catch (error) {
    console.warn("NFT activity initial poll failed:", error);
  }
  const interval = Math.max(5_000, config.nftActivityPollMs);
  setInterval(() => {
    void tick();
  }, interval);
  console.log(`NFT activity poller every ${interval}ms via ${config.marketplaceApiUrl}`);
}
