import { Bot, InlineKeyboard, InputFile } from "grammy";
import { config } from "../config.ts";
import { escapeHtml } from "../lib/format.ts";

const ELI_MIN = 1;
const ELI_MAX = 888;
const FETCH_MS = 10_000;
/** Telegram photo captions cap at 1024; keep traits readable under that. */
const CAPTION_MAX = 1024;

interface EliMetadata {
  name?: string;
  attributes?: { trait_type?: string; value?: string | number }[];
}

function parseEliId(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^#/, "");
  if (!/^[1-9]\d{0,2}$/.test(cleaned)) return null;
  const id = Number(cleaned);
  if (!Number.isInteger(id) || id < ELI_MIN || id > ELI_MAX) return null;
  return id;
}

function eliUrls(id: number): { image: string; metadata: string; marketplace: string } {
  const origin = config.eliSiteOrigin;
  return {
    image: `${origin}/nft/images/${id}.png`,
    metadata: `${origin}/nft/metadata/${id}`,
    marketplace: `${origin}/marketplace/eli/${id}`,
  };
}

async function fetchEliImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "image/png", "User-Agent": "BrotherEliAssistant/1" },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.includes("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch (error) {
    console.warn("Eli image fetch failed:", error);
    return null;
  }
}

async function fetchEliMetadata(url: string): Promise<EliMetadata | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "BrotherEliAssistant/1" },
      signal: AbortSignal.timeout(FETCH_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as EliMetadata;
  } catch {
    return null;
  }
}

function captionFor(id: number, meta: EliMetadata | null): string {
  const name = meta?.name?.trim() || `Brother Eli Bald Kings #${id}`;
  const lines = [`<b>${escapeHtml(name)}</b>`];
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

function eliKeyboard(urls: { image: string; marketplace: string }): InlineKeyboard {
  return new InlineKeyboard().url("Open on marketplace", urls.marketplace);
}

export function registerEliCommand(bot: Bot): void {
  bot.command("eli", async (ctx) => {
    if (!ctx.chat) return;

    const id = parseEliId(ctx.match);
    if (id == null) {
      await ctx.reply(`Usage: /eli <id>\nExample: /eli 233\nIDs are 1–${ELI_MAX}.`);
      return;
    }

    const urls = eliUrls(id);
    const waiting = await ctx.reply(`Loading Eli #${id}…`);

    const [png, meta] = await Promise.all([fetchEliImage(urls.image), fetchEliMetadata(urls.metadata)]);

    try {
      await ctx.api.deleteMessage(ctx.chat.id, waiting.message_id);
    } catch {
      // ignore
    }

    if (!png) {
      await ctx.reply(`Eli #${id} not found (unminted or unavailable).`);
      return;
    }

    await ctx.replyWithPhoto(new InputFile(png, `eli-${id}.png`), {
      caption: captionFor(id, meta),
      parse_mode: "HTML",
      reply_markup: eliKeyboard(urls),
    });
  });
}
