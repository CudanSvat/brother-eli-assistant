import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InputFile } from "grammy";

/**
 * Marketplace rarity chip (CSS overlay on brother-eli-slay), baked onto the
 * Eli PNG for Telegram. Static frame of the site badge — same palette, gem,
 * and top-right placement.
 */

interface TierPalette {
  a: string;
  b: string;
  c: string;
  text: string;
  border: string;
  mythic?: boolean;
}

const TIERS: Record<string, TierPalette> = {
  common: {
    a: "#f4f1ea",
    b: "#b9b3a6",
    c: "#8f897c",
    text: "#e6e1d6",
    border: "#ffffff40",
  },
  uncommon: {
    a: "#8ef08f",
    b: "#22a83a",
    c: "#0d6420",
    text: "#8ef08f",
    border: "#ffffff40",
  },
  rare: {
    a: "#8fd0ff",
    b: "#1f7ae0",
    c: "#0b3e8f",
    text: "#8fd0ff",
    border: "#ffffff40",
  },
  epic: {
    a: "#ff9ad5",
    b: "#d6249f",
    c: "#7a0d63",
    text: "#ff9ad5",
    border: "#ffffff40",
  },
  legendary: {
    a: "#fff6b0",
    b: "#f5c518",
    c: "#b87700",
    text: "#fff6b0",
    border: "#f5c51899",
  },
  mythic: {
    a: "#ffb3e6",
    b: "#9b5cff",
    c: "#4a148c",
    text: "#ffd9f2",
    border: "#9b5cff",
    mythic: true,
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));

function registerFonts(): void {
  if (GlobalFonts.has("Inter")) return;
  const dirs = [path.join(here, "../../assets/fonts"), path.join(process.cwd(), "assets/fonts")];
  for (const dir of dirs) {
    const regular = path.join(dir, "Inter-Regular.ttf");
    const bold = path.join(dir, "Inter-Bold.ttf");
    if (!existsSync(regular) || !existsSync(bold)) continue;
    GlobalFonts.registerFromPath(regular, "Inter");
    GlobalFonts.registerFromPath(bold, "Inter");
    if (GlobalFonts.has("Inter")) return;
  }
}

registerFonts();

function paletteFor(tier: string): TierPalette {
  return TIERS[tier.trim().toLowerCase()] ?? TIERS.common!;
}

/** Site gem: clip-path polygon(50% 0, 100% 38%, 82% 100%, 18% 100%, 0 38%). */
function drawGem(ctx: SKRSContext2D, x: number, y: number, size: number, p: TierPalette): void {
  const pts: [number, number][] = [
    [x + size * 0.5, y],
    [x + size, y + size * 0.38],
    [x + size * 0.82, y + size],
    [x + size * 0.18, y + size],
    [x, y + size * 0.38],
  ];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.closePath();

  const g = ctx.createLinearGradient(x, y, x + size, y + size);
  if (p.mythic) {
    g.addColorStop(0, "#ff5ec4");
    g.addColorStop(0.25, "#9b5cff");
    g.addColorStop(0.5, "#3fd0ff");
    g.addColorStop(0.75, "#6dffb0");
    g.addColorStop(1, "#ffd34d");
  } else {
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.12, "#ffffff");
    g.addColorStop(0.25, p.a);
    g.addColorStop(0.55, p.b);
    g.addColorStop(1, p.c);
  }
  ctx.fillStyle = g;
  ctx.shadowColor = p.a;
  ctx.shadowBlur = size * 0.35;
  ctx.fill();
  ctx.restore();
}

function drawSpacedText(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
): void {
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
}

function measureSpaced(ctx: SKRSContext2D, text: string, tracking: number): number {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + tracking;
  return Math.max(0, w - tracking);
}

function drawBadge(ctx: SKRSContext2D, imgW: number, imgH: number, tier: string): void {
  const p = paletteFor(tier);
  const label = tier.trim().toUpperCase() || "COMMON";
  const scale = Math.max(imgW, imgH) / 320;
  const pad = 6 * scale;
  const gem = 11 * scale;
  const fontSize = Math.max(10, 10 * scale);
  const tracking = fontSize * 0.06;
  const chipPadX = 6 * scale;
  const chipPadY = 2.5 * scale;
  const gap = 4 * scale;
  const radius = 4 * scale;

  ctx.font = `600 ${fontSize}px Inter`;
  const textW = measureSpaced(ctx, label, tracking);
  const chipW = chipPadX * 0.5 + gem + gap + textW + chipPadX;
  const chipH = Math.max(gem + chipPadY * 2, fontSize + chipPadY * 2);
  const x = imgW - pad - chipW;
  const y = pad;

  // Soft drop shadow under the chip (site: 0 2px 8px #0009).
  ctx.save();
  ctx.shadowColor = "#00000099";
  ctx.shadowBlur = 8 * scale;
  ctx.shadowOffsetY = 2 * scale;
  ctx.fillStyle = "#0d0b0fe6";
  roundRect(ctx, x, y, chipW, chipH, radius);
  ctx.fill();
  ctx.restore();

  // Chip fill + border.
  ctx.save();
  roundRect(ctx, x, y, chipW, chipH, radius);
  ctx.fillStyle = "#0d0b0fe6";
  ctx.fill();
  if (p.mythic) {
    const border = ctx.createLinearGradient(x, y, x + chipW, y);
    border.addColorStop(0, "#ff5ec4");
    border.addColorStop(0.25, "#9b5cff");
    border.addColorStop(0.5, "#3fd0ff");
    border.addColorStop(0.75, "#6dffb0");
    border.addColorStop(1, "#ffd34d");
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(1, 1.5 * scale);
  } else {
    ctx.strokeStyle = p.border;
    ctx.lineWidth = Math.max(1, scale);
  }
  ctx.stroke();
  // Inset highlight.
  ctx.beginPath();
  ctx.moveTo(x + radius, y + 1 * scale);
  ctx.lineTo(x + chipW - radius, y + 1 * scale);
  ctx.strokeStyle = "#ffffff26";
  ctx.lineWidth = Math.max(1, scale);
  ctx.stroke();
  ctx.restore();

  const gemX = x + chipPadX * 0.5;
  const gemY = y + (chipH - gem) / 2;
  drawGem(ctx, gemX, gemY, gem, p);

  ctx.fillStyle = p.text;
  ctx.font = `600 ${fontSize}px Inter`;
  ctx.textBaseline = "middle";
  drawSpacedText(ctx, label, gemX + gem + gap, y + chipH / 2 + fontSize * 0.05, tracking);
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export async function renderEliWithRarityBadge(
  imageUrl: string,
  tier: string,
): Promise<Buffer> {
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": "BrotherEliAssistant/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Eli image ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const img = await loadImage(bytes);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  drawBadge(ctx, img.width, img.height, tier);
  return canvas.toBuffer("image/png");
}

/** Prefer badged PNG; fall back to the remote URL if compositing fails. */
export async function eliPhotoSource(
  imageUrl: string,
  tier?: string | null,
  fileName = "eli.png",
): Promise<string | InputFile> {
  if (!tier?.trim()) return imageUrl;
  try {
    const png = await renderEliWithRarityBadge(imageUrl, tier);
    return new InputFile(png, fileName);
  } catch (error) {
    console.warn("Eli rarity badge composite failed, sending plain image:", error);
    return imageUrl;
  }
}
