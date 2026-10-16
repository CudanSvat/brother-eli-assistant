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

export function eliCaption(
  id: number,
  meta: EliMetadata | null,
  headline?: string | null,
): string {
  const name = meta?.name?.trim() || `Brother Eli Bald Kings #${id}`;
  const lines: string[] = [];
  if (headline?.trim()) {
    lines.push(`<b>${escapeHtml(headline.trim())}</b>`);
    lines.push("");
  }
  lines.push(`<b>${escapeHtml(name)}</b>`);
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
