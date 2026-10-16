import { InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import { escapeHtml } from "../lib/format.ts";

export const ELI_MIN = 1;
export const ELI_MAX = 888;
const FETCH_MS = 10_000;
/** Telegram photo captions cap at 1024; keep traits readable under that. */
const CAPTION_MAX = 1024;

export interface EliMetadata {
  name?: string;
  attributes?: { trait_type?: string; value?: string | number }[];
}

export interface EliUrls {
  image: string;
  metadata: string;
  marketplace: string;
}

/** Same tiers as brother-eli-slay `/api/rarity` (Mythic → Common). */
export interface EliRarity {
  tier: string;
  rank?: number;
  supply?: number;
}

let tiersCache: { at: number; tiers: Record<string, string> } | null = null;
const TIERS_CACHE_MS = 5 * 60_000;

export function parseEliId(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^#/, "");
  if (!/^[1-9]\d{0,2}$/.test(cleaned)) return null;
  const id = Number(cleaned);
  if (!Number.isInteger(id) || id < ELI_MIN || id > ELI_MAX) return null;
  return id;
}

export function eliUrls(id: number): EliUrls {
  const origin = config.eliSiteOrigin;
  return {
    image: `${origin}/nft/images/${id}.png`,
    metadata: `${origin}/nft/metadata/${id}`,
    marketplace: `${origin}/marketplace/eli/${id}`,
  };
}

export async function fetchEliMetadata(url: string): Promise<EliMetadata | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "BrotherEliAssistant/1" },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as EliMetadata;
  } catch (error) {
    console.warn("Eli metadata fetch failed:", error);
    return null;
  }
}

async function fetchTierMap(): Promise<Record<string, string> | null> {
  const now = Date.now();
  if (tiersCache && now - tiersCache.at < TIERS_CACHE_MS) return tiersCache.tiers;
  try {
    const res = await fetch(`${config.eliSiteOrigin}/api/rarity/tiers`, {
      headers: { Accept: "application/json", "User-Agent": "BrotherEliAssistant/1" },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (!res.ok) return tiersCache?.tiers ?? null;
    const body = (await res.json()) as { tiers?: Record<string, string> };
    if (!body.tiers || typeof body.tiers !== "object") return tiersCache?.tiers ?? null;
    tiersCache = { at: now, tiers: body.tiers };
    return body.tiers;
  } catch (error) {
    console.warn("Eli rarity tiers fetch failed:", error);
    return tiersCache?.tiers ?? null;
  }
}

/** Rank + tier from the site rarity API (same source as marketplace badges). */
export async function fetchEliRarity(id: number): Promise<EliRarity | null> {
  try {
    const res = await fetch(`${config.eliSiteOrigin}/api/rarity`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "BrotherEliAssistant/1",
      },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        tier?: string;
        rank?: number;
        supply?: number;
      };
      if (body.tier) {
        return {
          tier: body.tier,
          rank: typeof body.rank === "number" ? body.rank : undefined,
          supply: typeof body.supply === "number" ? body.supply : undefined,
        };
      }
    }
  } catch (error) {
    console.warn("Eli rarity fetch failed:", error);
  }

  const tiers = await fetchTierMap();
  const tier = tiers?.[String(id)];
  return tier ? { tier } : null;
}

function rarityLine(rarity: EliRarity | null | undefined): string | null {
  if (!rarity?.tier) return null;
  const tier = escapeHtml(rarity.tier.toUpperCase());
  if (rarity.rank != null && rarity.supply != null) {
    return `<b>${tier}</b> · rank #${rarity.rank} / ${rarity.supply}`;
  }
  return `<b>${tier}</b>`;
}

export function eliCaption(
  id: number,
  meta: EliMetadata | null,
  headline?: string | null,
  rarity?: EliRarity | null,
): string {
  const name = meta?.name?.trim() || `Brother Eli Bald Kings #${id}`;
  const lines: string[] = [];
  if (headline?.trim()) {
    lines.push(`<b>${escapeHtml(headline.trim())}</b>`);
    lines.push("");
  }
  lines.push(`<b>${escapeHtml(name)}</b>`);
  const rarityText = rarityLine(rarity);
  if (rarityText) lines.push(rarityText);
  const traits = (meta?.attributes || []).filter(
    (a) => a.trait_type && a.value != null && String(a.value).length,
  );
  if (traits.length) {
    lines.push("");
    lines.push("<b>Traits</b>");
    for (const a of traits) {
      lines.push(
        `<b>${escapeHtml(String(a.trait_type).toUpperCase())}</b>\n${escapeHtml(String(a.value))}`,
      );
    }
  }
  let caption = lines.join("\n");
  if (caption.length > CAPTION_MAX) caption = caption.slice(0, CAPTION_MAX - 1) + "…";
  return caption;
}

export function eliKeyboard(urls: Pick<EliUrls, "marketplace">): InlineKeyboard {
  return new InlineKeyboard().url("Open on marketplace", urls.marketplace);
}
