import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { BOT_NAME } from "../config.ts";
import type { Candle } from "../types.ts";

const WIDTH = 1080;
const HEIGHT = 560;
const C = {
  bg: "#0b0f14",
  bgTop: "#121821",
  grid: "#1d2633",
  axis: "#8b95a8",
  title: "#f4f7fb",
  muted: "#7d8799",
  up: "#22c55e",
  down: "#ef4444",
  upFill: "#16a34a",
  downFill: "#dc2626",
  volumeUp: "rgba(34, 197, 94, 0.35)",
  volumeDown: "rgba(239, 68, 68, 0.35)",
  priceLine: "rgba(244, 247, 251, 0.35)",
};

function finite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  if (value >= 0.0001) return value.toFixed(6);
  return value.toPrecision(3);
}

function formatTime(unix: number): string {
  const ms = unix < 1e12 ? unix * 1000 : unix;
  const d = new Date(ms);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function cleanCandles(raw: Candle[]): Candle[] {
  const sorted = [...raw]
    .filter(
      (c) =>
        finite(c.open) &&
        finite(c.high) &&
        finite(c.low) &&
        finite(c.close) &&
        c.high >= c.low,
    )
    .sort((a, b) => a.time - b.time);

  const unique: Candle[] = [];
  for (const candle of sorted) {
    const prev = unique[unique.length - 1];
    if (prev && prev.time === candle.time) {
      unique[unique.length - 1] = candle;
    } else {
      unique.push(candle);
    }
  }

  const closes = unique.map((c) => c.close).sort((a, b) => a - b);
  const typical = percentile(closes, 50) || closes[0] || 0;
  if (!typical) return unique;

  return unique.filter((c) => {
    const mid = (c.open + c.close) / 2;
    if (mid > typical * 25 || mid < typical / 25) return false;
    if (c.high > mid * 8 || c.low < mid / 8) {
      c.high = Math.min(c.high, mid * 3);
      c.low = Math.max(c.low, mid / 3);
    }
    return true;
  });
}

function priceWindow(candles: Candle[]): { min: number; max: number } {
  const samples = candles.flatMap((c) => [c.open, c.close, c.high, c.low]).sort((a, b) => a - b);
  let min = percentile(samples, 4);
  let max = percentile(samples, 96);
  if (max <= min) {
    min = Math.min(...samples);
    max = Math.max(...samples);
  }
  const pad = (max - min) * 0.12 || max * 0.04;
  return { min: Math.max(0, min - pad), max: max + pad };
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step / 1000; v += step) ticks.push(v);
  return ticks;
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

export function renderChartPng(symbol: string, raw: Candle[]): Buffer | null {
  const candles = cleanCandles(raw);
  if (candles.length < 3) return null;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  bg.addColorStop(0, C.bgTop);
  bg.addColorStop(1, C.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const pad = { top: 64, right: 88, bottom: 36, left: 20 };
  const volH = 78;
  const gap = 10;
  const plotX = pad.left;
  const plotY = pad.top;
  const plotW = WIDTH - pad.left - pad.right;
  const plotH = HEIGHT - pad.top - pad.bottom - volH - gap;
  const volY = plotY + plotH + gap;

  const { min, max } = priceWindow(candles);
  const span = max - min || 1;
  const maxVol = Math.max(...candles.map((c) => c.volume || 0), 1);
  const slot = plotW / candles.length;
  const bodyW = Math.max(3, Math.min(14, slot * 0.62));

  const yFor = (price: number) => {
    const clipped = Math.min(max, Math.max(min, price));
    return plotY + ((max - clipped) / span) * plotH;
  };
  const xFor = (i: number) => plotX + (i + 0.5) * slot;

  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  const ticks = niceTicks(min, max, 5);
  ctx.font = "12px sans-serif";
  ctx.fillStyle = C.axis;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const tick of ticks) {
    const y = yFor(tick);
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();
    ctx.fillText(formatPrice(tick), plotX + plotW + 8, y);
  }

  ctx.strokeStyle = "#2a3444";
  ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);

  const last = candles[candles.length - 1]!;
  const first = candles[0]!;
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = C.priceLine;
  ctx.beginPath();
  ctx.moveTo(plotX, yFor(last.close));
  ctx.lineTo(plotX + plotW, yFor(last.close));
  ctx.stroke();
  ctx.setLineDash([]);

  candles.forEach((candle, i) => {
    const x = xFor(i);
    const up = candle.close >= candle.open;
    const vol = candle.volume || 0;
    const vh = Math.max(2, (vol / maxVol) * (volH - 4));
    ctx.fillStyle = up ? C.volumeUp : C.volumeDown;
    ctx.fillRect(x - bodyW / 2, volY + volH - vh, bodyW, vh);
  });

  candles.forEach((candle, i) => {
    const x = xFor(i);
    const up = candle.close >= candle.open;
    const color = up ? C.up : C.down;
    ctx.strokeStyle = color;
    ctx.fillStyle = up ? C.upFill : C.downFill;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, yFor(candle.high));
    ctx.lineTo(x, yFor(candle.low));
    ctx.stroke();
    const top = yFor(Math.max(candle.open, candle.close));
    const bot = yFor(Math.min(candle.open, candle.close));
    const h = Math.max(2, bot - top);
    roundRect(ctx, x - bodyW / 2, top, bodyW, h, 1);
    ctx.fill();
  });

  const rawDt = candles.length > 1 ? candles[1]!.time - candles[0]!.time : 900;
  const dtSec = rawDt > 10_000 ? rawDt / 1000 : rawDt;
  const tf = dtSec >= 3000 ? "1h" : dtSec >= 700 ? "15m" : "5m";
  const change = ((last.close - first.open) / first.open) * 100;
  const up = change >= 0;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.title;
  ctx.font = "700 24px sans-serif";
  ctx.fillText(`${symbol} / USD · ${tf}`, pad.left, 32);
  ctx.font = "500 13px sans-serif";
  ctx.fillStyle = C.muted;
  ctx.fillText("GeckoTerminal", pad.left, 48);

  const pill = `${formatPrice(last.close)}  ${up ? "+" : ""}${change.toFixed(1)}%`;
  ctx.font = "700 18px sans-serif";
  const pillW = ctx.measureText(pill).width + 24;
  ctx.fillStyle = up ? "rgba(34, 197, 94, 0.16)" : "rgba(239, 68, 68, 0.16)";
  roundRect(ctx, WIDTH - pad.right - pillW, 12, pillW, 28, 8);
  ctx.fill();
  ctx.fillStyle = up ? C.up : C.down;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(pill, WIDTH - pad.right - pillW / 2, 26);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.axis;
  ctx.font = "12px sans-serif";
  const labelEvery = Math.max(1, Math.ceil(candles.length / 6));
  candles.forEach((candle, i) => {
    if (i % labelEvery !== 0 && i !== candles.length - 1) return;
    ctx.fillText(formatTime(candle.time), xFor(i), HEIGHT - 12);
  });

  ctx.textAlign = "left";
  ctx.fillStyle = C.muted;
  ctx.font = "11px sans-serif";
  ctx.fillText(`${BOT_NAME}  ·  times UTC`, pad.left, volY - 2);

  return canvas.toBuffer("image/png");
}
