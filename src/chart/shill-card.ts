import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBurnAmount } from "../market/burn.ts";
import { formatTokenPrice, formatUsd, normalizeAddress } from "../lib/format.ts";

const WIDTH = 760;

const C = {
  gridBg: "#e8dfc8",
  gridLine: "rgba(110, 90, 55, 0.22)",
  paper: "#1a66c4",
  paperDeep: "#0f4fa0",
  paperLight: "#2b7ad6",
  fiber: "#f3eee4",
  polaroid: "#f8f5ef",
  title: "#ffffff",
  muted: "rgba(230, 238, 250, 0.82)",
  addr: "rgba(200, 215, 235, 0.72)",
  up: "#5dff9a",
  down: "#ff6b6b",
  flat: "#e8eef8",
  barBg: "#faf8f3",
  barLabel: "#6e6e6e",
  barValue: "#111111",
  footer: "#0a0a0a",
  slay: "#f5d031",
  footerText: "#f0f0f0",
};

export interface ShillCardInput {
  symbol: string;
  name: string;
  address: string;
  image?: Image | null;
  priceUsd: number | null;
  marketCap: number | null;
  /** Launchpad volume (not always strictly 24h, but discover treats it as activity). */
  volumeUsd: number | null;
  change24h: number | null;
  holders: number | null;
  /** Whole-token units burned (balance at 0x…dEaD). */
  burned?: number | null;
  at?: Date;
}

const here = path.dirname(fileURLToPath(import.meta.url));
let fontsReady = false;
let cobaltPaper: Image | null | undefined;
let tapeTexture: Image | null | undefined;

function assetPath(...parts: string[]): string | null {
  const candidates = [
    path.join(here, "../../assets", ...parts),
    path.join(process.cwd(), "assets", ...parts),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function loadBrandTextures(): Promise<void> {
  if (cobaltPaper !== undefined && tapeTexture !== undefined) return;
  const cobaltPath = assetPath("cobalt-paper.webp");
  const tapePath = assetPath("tape-280.webp");
  try {
    cobaltPaper = cobaltPath ? await loadImage(cobaltPath) : null;
  } catch {
    cobaltPaper = null;
  }
  try {
    tapeTexture = tapePath ? await loadImage(tapePath) : null;
  } catch {
    tapeTexture = null;
  }
}

function formatHolders(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = Math.round(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function registerFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  const dirs = [path.join(here, "../../assets/fonts"), path.join(process.cwd(), "assets/fonts")];
  for (const dir of dirs) {
    const interR = path.join(dir, "Inter-Regular.ttf");
    const interB = path.join(dir, "Inter-Bold.ttf");
    if (existsSync(interR) && existsSync(interB) && !GlobalFonts.has("Inter")) {
      GlobalFonts.registerFromPath(interR, "Inter");
      GlobalFonts.registerFromPath(interB, "Inter");
    }
    const elite = path.join(dir, "SpecialElite-Regular.ttf");
    if (existsSync(elite) && !GlobalFonts.has("Special Elite")) {
      GlobalFonts.registerFromPath(elite, "Special Elite");
    }
    const baskR = path.join(dir, "LibreBaskerville-Regular.ttf");
    const baskB = path.join(dir, "LibreBaskerville-Bold.ttf");
    if (!GlobalFonts.has("Libre Baskerville")) {
      if (existsSync(baskR)) GlobalFonts.registerFromPath(baskR, "Libre Baskerville");
      if (existsSync(baskB)) GlobalFonts.registerFromPath(baskB, "Libre Baskerville");
    }
  }
  if (!GlobalFonts.has("Inter")) {
    console.warn("Inter font registration failed; shill card labels may be missing");
  }
}

registerFonts();

function fontInter(size: number, weight = 400): string {
  return `${weight} ${size}px Inter`;
}

function fontElite(size: number): string {
  return GlobalFonts.has("Special Elite") ? `${size}px "Special Elite"` : fontInter(size, 500);
}

function fontSerif(size: number, weight = 700): string {
  return GlobalFonts.has("Libre Baskerville")
    ? `${weight} ${size}px "Libre Baskerville"`
    : fontInter(size, weight);
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function formatCardDate(at: Date): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${months[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2, "0")}, ${at.getUTCFullYear()}`;
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const lines: string[] = [];
  let rest = text;
  while (rest.length) {
    let fit = rest.length;
    while (fit > 1 && ctx.measureText(rest.slice(0, fit)).width > maxWidth) fit -= 1;
    lines.push(rest.slice(0, fit));
    rest = rest.slice(fit);
    if (lines.length >= 3) {
      if (rest) lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, -1)}…`;
      break;
    }
  }
  return lines;
}

function formatChange(value: number | null): { text: string; color: string; up: boolean | null } {
  if (value == null || !Number.isFinite(value)) {
    return { text: "—", color: C.flat, up: null };
  }
  const up = value >= 0;
  return {
    text: `${up ? "+" : "-"}${Math.abs(value).toFixed(2)}%`,
    color: value === 0 ? C.flat : up ? C.up : C.down,
    up: value === 0 ? null : up,
  };
}

/** Compact MC like the launchpad card (`$23.42k`). */
function formatMcHero(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}b`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}m`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function tornRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  tooth = 12,
): void {
  const rand = mulberry32(seed);
  const step = 11;
  ctx.beginPath();
  ctx.moveTo(x + (rand() - 0.5) * tooth, y + (rand() - 0.5) * tooth);

  for (let px = x; px < x + w; px += step) {
    const nx = Math.min(x + w, px + step);
    ctx.lineTo(nx, y + (rand() - 0.45) * tooth * 2.2);
  }
  for (let py = y; py < y + h; py += step) {
    const ny = Math.min(y + h, py + step);
    ctx.lineTo(x + w + (rand() - 0.45) * tooth * 2.2, ny);
  }
  for (let px = x + w; px > x; px -= step) {
    const nx = Math.max(x, px - step);
    ctx.lineTo(nx, y + h + (rand() - 0.45) * tooth * 2.2);
  }
  for (let py = y + h; py > y; py -= step) {
    const ny = Math.max(y, py - step);
    ctx.lineTo(x + (rand() - 0.45) * tooth * 2.2, ny);
  }
  ctx.closePath();
}

function drawGridBackground(ctx: SKRSContext2D, height: number): void {
  ctx.fillStyle = C.gridBg;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth = 1;
  const gap = 24;
  for (let x = 0; x <= WIDTH; x += gap) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += gap) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(WIDTH, y + 0.5);
    ctx.stroke();
  }
}

function paintCrumple(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, seed: number): void {
  const rand = mulberry32(seed);

  for (let i = 0; i < 14; i++) {
    const y0 = y + rand() * h;
    const amp = 6 + rand() * 18;
    const wave = 40 + rand() * 90;
    const phase = rand() * Math.PI * 2;
    ctx.beginPath();
    for (let px = x; px <= x + w; px += 4) {
      const py = y0 + Math.sin((px - x) / wave + phase) * amp + (rand() - 0.5) * 2;
      if (px === x) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = `rgba(0, 30, 70, ${0.06 + rand() * 0.1})`;
    ctx.lineWidth = 1.5 + rand() * 3;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.04 + rand() * 0.08})`;
    ctx.lineWidth = 1;
    ctx.translate(0, 2);
    ctx.stroke();
    ctx.translate(0, -2);
  }

  for (let i = 0; i < 90; i++) {
    const px = x + rand() * w;
    const py = y + rand() * h;
    const r = 12 + rand() * 55;
    ctx.fillStyle =
      rand() > 0.5 ? `rgba(255,255,255,${0.03 + rand() * 0.05})` : `rgba(0,25,60,${0.04 + rand() * 0.07})`;
    ctx.beginPath();
    ctx.ellipse(px, py, r, r * (0.35 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBluePaper(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  tornRectPath(ctx, x + 6, y + 8, w, h, 91, 14);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = C.fiber;
  tornRectPath(ctx, x - 4, y - 4, w + 8, h + 8, 17, 16);
  ctx.fill();
  ctx.restore();

  ctx.save();
  tornRectPath(ctx, x, y, w, h, 42, 13);
  ctx.clip();
  if (cobaltPaper) {
    // Cover with launchpad cobalt scrap texture
    const scale = Math.max((w + 48) / cobaltPaper.width, (h + 48) / cobaltPaper.height);
    const dw = cobaltPaper.width * scale;
    const dh = cobaltPaper.height * scale;
    ctx.drawImage(cobaltPaper, x + w / 2 - dw / 2, y + h / 2 - dh / 2, dw, dh);
  } else {
    const grad = ctx.createLinearGradient(x, y, x + w * 0.7, y + h);
    grad.addColorStop(0, C.paperLight);
    grad.addColorStop(0.4, C.paper);
    grad.addColorStop(1, C.paperDeep);
    ctx.fillStyle = grad;
    ctx.fillRect(x - 24, y - 24, w + 48, h + 48);
    paintCrumple(ctx, x, y, w, h, 77);
  }
  ctx.restore();
}

function drawCheckerTape(ctx: SKRSContext2D, cx: number, cy: number, angle: number, len = 88, thick = 24): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  if (tapeTexture) {
    ctx.drawImage(tapeTexture, -len / 2, -thick / 2, len, thick);
  } else {
    ctx.fillStyle = "rgba(175, 180, 186, 0.78)";
    ctx.fillRect(-len / 2, -thick / 2, len, thick);
    const cell = 5;
    for (let row = 0; row < thick; row += cell) {
      for (let col = 0; col < len; col += cell) {
        ctx.fillStyle =
          ((row / cell) + (col / cell)) % 2 < 1 ? "rgba(255,255,255,0.22)" : "rgba(80,90,100,0.18)";
        ctx.fillRect(-len / 2 + col, -thick / 2 + row, cell, cell);
      }
    }
    ctx.strokeStyle = "rgba(90, 100, 110, 0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-len / 2 + 0.5, -thick / 2 + 0.5, len - 1, thick - 1);
  }
  ctx.restore();
}

function drawPolaroid(
  ctx: SKRSContext2D,
  px: number,
  py: number,
  symbol: string,
  image: Image | null | undefined,
): { bottom: number } {
  const pw = 158;
  const ph = 186;
  const pad = 9;
  const captionH = 32;

  ctx.save();
  ctx.translate(px + 3, py + 5);
  ctx.rotate((-2.8 * Math.PI) / 180);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, 0, pw, ph);
  ctx.restore();

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate((-2.4 * Math.PI) / 180);

  ctx.fillStyle = C.polaroid;
  ctx.fillRect(0, 0, pw, ph);
  ctx.strokeStyle = "rgba(0,0,0,0.14)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, pw - 1, ph - 1);

  const iw = pw - pad * 2;
  const ih = ph - pad - captionH;
  ctx.fillStyle = "#111";
  ctx.fillRect(pad, pad, iw, ih);

  if (image) {
    const scale = Math.max(iw / image.width, ih / image.height);
    const dw = image.width * scale;
    const dh = image.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, pad, iw, ih);
    ctx.clip();
    ctx.drawImage(image, pad + (iw - dw) / 2, pad + (ih - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    const hue = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    ctx.fillStyle = `hsl(${hue} 55% 40%)`;
    ctx.fillRect(pad, pad, iw, ih);
    ctx.fillStyle = "#fff";
    ctx.font = fontSerif(30, 700);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol.slice(0, 4).toUpperCase(), pad + iw / 2, pad + ih / 2);
  }

  ctx.fillStyle = "#111";
  ctx.font = fontSerif(17, 700);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`$${symbol.toUpperCase()}`, pw / 2, ph - captionH / 2 + 1);
  ctx.restore();

  drawCheckerTape(ctx, px + 20, py + 5, (-32 * Math.PI) / 180, 86, 20);
  drawCheckerTape(ctx, px + pw - 12, py + 16, (22 * Math.PI) / 180, 72, 18);

  return { bottom: py + ph + 6 };
}

function drawFooterBanner(ctx: SKRSContext2D, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  tornRectPath(ctx, x + 3, y + 4, w, h, 201, 9);
  ctx.fill();
  ctx.restore();

  ctx.save();
  tornRectPath(ctx, x, y, w, h, 55, 9);
  ctx.clip();
  ctx.fillStyle = C.footer;
  ctx.fillRect(x - 12, y - 12, w + 24, h + 24);
  paintCrumple(ctx, x, y, w, h, 9);
  ctx.restore();

  ctx.fillStyle = C.slay;
  ctx.font = fontSerif(30, 700);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("$SLAY", x + 20, y + h / 2 + 1);

  ctx.fillStyle = C.footerText;
  ctx.font = fontElite(12);
  ctx.textAlign = "right";
  ctx.fillText("Start trading at", x + w - 20, y + h / 2 - 10);
  ctx.font = fontElite(13);
  ctx.fillText("brothereli.com/launchpad", x + w - 20, y + h / 2 + 10);
}

function drawStatsBar(
  ctx: SKRSContext2D,
  bx: number,
  by: number,
  bw: number,
  cols: { label: string; value: string }[],
): number {
  const bh = 64;
  ctx.fillStyle = C.barBg;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 2;
  ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);

  const colW = bw / cols.length;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    const cx = bx + colW * i + colW / 2;
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(bx + colW * i, by + 8);
      ctx.lineTo(bx + colW * i, by + bh - 8);
      ctx.strokeStyle = "rgba(0,0,0,0.32)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = C.barLabel;
    ctx.font = fontElite(11);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(col.label, cx, by + 17);
    ctx.fillStyle = C.barValue;
    ctx.font = fontSerif(17, 700);
    ctx.fillText(col.value, cx, by + 42);
  }
  return bh;
}

/**
 * Scrapbook shill card — launchpad PNL vibes, height hugs the content.
 */
export async function renderShillCardPng(input: ShillCardInput): Promise<Buffer> {
  registerFonts();
  await loadBrandTextures();
  const at = input.at ?? new Date();
  const change = formatChange(input.change24h);

  // Layout constants (content-driven height — no empty blue under the bar)
  const paperX = 32;
  const paperY = 24;
  const paperW = WIDTH - 64;
  const polaroidX = paperX + 30;
  const polaroidY = paperY + 30;
  const textLeft = paperX + 214;
  const midX = paperX + paperW / 2;

  // Measure hero → stats → paper bottom → footer → canvas
  const polaroidBottom = polaroidY + 186 + 6;
  const heroY = Math.max(polaroidBottom + 10, paperY + 230);
  const moveY = heroY + 72;
  const barY = moveY + 28;
  const barH = 64;
  const paperBottomPad = 22;
  const paperH = barY + barH + paperBottomPad - paperY;
  const footerY = paperY + paperH + 14;
  const footerH = 56;
  const height = footerY + footerH + 22;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  drawGridBackground(ctx, height);
  drawBluePaper(ctx, paperX, paperY, paperW, paperH);
  drawPolaroid(ctx, polaroidX, polaroidY, input.symbol, input.image);

  const textRight = paperX + paperW - 28;
  ctx.fillStyle = C.muted;
  ctx.font = fontElite(13);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(formatCardDate(at), textLeft, paperY + 42);

  ctx.fillStyle = C.title;
  ctx.font = fontSerif(28, 700);
  const name = input.name.trim() || input.symbol;
  const maxNameW = textRight - textLeft;
  let displayName = name;
  if (ctx.measureText(displayName).width > maxNameW) {
    while (displayName.length > 3 && ctx.measureText(`${displayName}…`).width > maxNameW) {
      displayName = displayName.slice(0, -1);
    }
    displayName = `${displayName}…`;
  }
  ctx.fillText(displayName, textLeft, paperY + 66);

  // Full CA, wrapped (tap-to-copy lives in the Telegram caption)
  const ca = normalizeAddress(input.address);
  ctx.fillStyle = C.addr;
  ctx.font = fontElite(11);
  const caLines = wrapText(ctx, ca, maxNameW);
  let caY = paperY + 102;
  for (const line of caLines) {
    ctx.fillText(line, textLeft, caY);
    caY += 15;
  }

  const heroColor =
    input.marketCap == null || !Number.isFinite(input.marketCap)
      ? C.flat
      : change.up === false
        ? C.down
        : C.up;

  ctx.fillStyle = heroColor;
  ctx.font = fontSerif(58, 700);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(formatMcHero(input.marketCap), midX, heroY + 30);

  ctx.font = fontSerif(22, 700);
  const moveW = ctx.measureText(change.text).width;
  const tri = 9;
  const gap = change.up == null ? 0 : tri + 12;
  if (change.up != null) {
    ctx.fillStyle = change.color;
    ctx.beginPath();
    const tx = midX - moveW / 2 - gap;
    if (change.up) {
      ctx.moveTo(tx, moveY + tri * 0.5);
      ctx.lineTo(tx + tri, moveY + tri * 0.5);
      ctx.lineTo(tx + tri / 2, moveY - tri * 0.6);
    } else {
      ctx.moveTo(tx, moveY - tri * 0.5);
      ctx.lineTo(tx + tri, moveY - tri * 0.5);
      ctx.lineTo(tx + tri / 2, moveY + tri * 0.6);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = change.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(change.text, midX + (change.up == null ? 0 : gap / 2), moveY);

  const stats: { label: string; value: string }[] = [
    { label: "PRICE", value: formatTokenPrice(input.priceUsd) },
  ];
  // Prefer burned over holders on the card when both exist (holders stay in the caption).
  if (input.burned != null && Number.isFinite(input.burned) && input.burned > 0) {
    stats.push({
      label: "BURNED",
      value: `${formatBurnAmount(input.burned)} $${input.symbol}`,
    });
  } else if (input.holders != null && Number.isFinite(input.holders) && input.holders > 0) {
    stats.push({ label: "HOLDERS", value: formatHolders(input.holders) });
  }
  stats.push({ label: "VOLUME", value: formatUsd(input.volumeUsd) });
  drawStatsBar(ctx, paperX + 24, barY, paperW - 48, stats);

  drawFooterBanner(ctx, 40, footerY, WIDTH - 80, footerH);

  return canvas.toBuffer("image/png");
}

export async function loadShillImage(url: string | null | undefined): Promise<Image | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { Accept: "image/*", "User-Agent": "BrotherEliAssistant/1" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return await loadImage(bytes);
  } catch (error) {
    console.warn("Shill image load failed:", error);
    return null;
  }
}
