import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOT_NAME } from "../config.ts";
import type { Candle } from "../types.ts";

const WIDTH = 1080;
const HEIGHT = 600;
const MIN_TRADE_CANDLES = 8;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const C = {
  bg: "#070b12",
  bgTop: "#121826",
  pane: "#0c111b",
  paneBorder: "#243044",
  grid: "rgba(148, 163, 184, 0.09)",
  axis: "#9aa6b8",
  title: "#f4f7fb",
  muted: "#8b96a8",
  dim: "#667085",
  up: "#22c55e",
  down: "#ef4444",
  upFill: "#16a34a",
  downFill: "#dc2626",
  volumeUp: "rgba(34, 197, 94, 0.38)",
  volumeDown: "rgba(239, 68, 68, 0.38)",
  priceLine: "rgba(244, 247, 251, 0.42)",
  tagText: "#ffffff",
};

export interface ChartRenderOptions {
  quote?: string;
  intervalLabel?: string;
  /** Stamp the live buy onto the chart when Gecko OHLCV is behind. */
  spot?: { price: number; volumeUsd?: number; timeSec?: number };
  /**
   * Buy cards skip empty/no-trade buckets. Command charts keep the full
   * continuous series so longer windows stay readable.
   */
  keepEmpty?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function registerInterFonts(): void {
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
  console.warn("Inter font registration failed; chart labels may be missing on this host");
}

registerInterFonts();

function font(size: number, weight = 400): string {
  return `${weight} ${size}px Inter`;
}

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
  if (value >= 0.000001) return value.toFixed(8);
  return value.toPrecision(3);
}

function formatPct(change: number): string {
  const sign = change >= 0 ? "+" : "";
  const abs = Math.abs(change);
  const digits = abs >= 10 ? 1 : abs >= 1 ? 2 : 2;
  return `${sign}${change.toFixed(digits)}%`;
}

function formatVolume(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 10) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

function candleMs(unix: number): number {
  return unix < 1e12 ? unix * 1000 : unix;
}

function formatDateTime(unix: number): string {
  const d = new Date(candleMs(unix));
  const day = d.getUTCDate();
  const mon = MONTHS[d.getUTCMonth()]!;
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon} ${h}:${m}`;
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function validCandles(raw: Candle[]): Candle[] {
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
    if (prev && prev.time === candle.time) unique[unique.length - 1] = candle;
    else unique.push(candle);
  }
  return unique;
}

function hasRealRange(candle: Candle): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const scale = Math.max(Math.abs(hi), Math.abs(lo), 1e-18);
  return (hi - lo) / scale > 1e-7;
}

/** Empty Gecko buckets: zero/missing volume and a carried-forward flat OHLC. */
function isEmptyCandle(candle: Candle): boolean {
  const volume = Number.isFinite(candle.volume) ? candle.volume : 0;
  return volume <= 0 && !hasRealRange(candle);
}

function intervalStats(candles: Candle[]): { nativeMs: number; medianMs: number } {
  const fallback = 15 * 60 * 1000;
  if (candles.length < 2) return { nativeMs: fallback, medianMs: fallback };
  const dts: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const dt = candleMs(candles[i]!.time) - candleMs(candles[i - 1]!.time);
    if (dt > 0) dts.push(dt);
  }
  if (!dts.length) return { nativeMs: fallback, medianMs: fallback };
  dts.sort((a, b) => a - b);
  return { nativeMs: dts[0]!, medianMs: dts[Math.floor(dts.length / 2)]! };
}

function intervalLabelFromMs(ms: number): string {
  if (ms <= 90 * 1000) return "1m";
  if (ms <= 6 * 60 * 1000) return "5m";
  if (ms <= 20 * 60 * 1000) return "15m";
  if (ms <= 90 * 60 * 1000) return "1h";
  return "1h";
}

function windowLabel(first: Candle, last: Candle): string {
  const spanMs = Math.max(0, candleMs(last.time) - candleMs(first.time));
  const hours = spanMs / 3_600_000;
  if (hours >= 40) return `last ${Math.max(2, Math.round(hours / 24))}d of trades`;
  if (hours >= 20) return `last ${Math.round(hours)}h of trades`;
  if (hours >= 1.5) return `last ${Math.round(hours)}h of trades`;
  const mins = Math.max(1, Math.round(spanMs / 60_000));
  return `last ${mins}m of trades`;
}

function clipOutliers(raw: Candle[]): Candle[] {
  const candles = raw.map((c) => ({ ...c }));
  const closes = candles.map((c) => c.close).sort((a, b) => a - b);
  const typical = percentile(closes, 50) || closes[0] || 0;
  if (!typical) return candles;

  return candles.filter((c) => {
    const mid = (c.open + c.close) / 2;
    if (mid > typical * 25 || mid < typical / 25) return false;
    if (c.high > mid * 8 || c.low < mid / 8) {
      c.high = Math.min(c.high, mid * 3);
      c.low = Math.max(c.low, mid / 3);
    }
    return true;
  });
}

function selectPlotCandles(
  raw: Candle[],
  keepEmpty = false,
): {
  candles: Candle[];
  skippedEmpty: boolean;
  intervalMs: number;
} {
  const valid = validCandles(raw);
  const { nativeMs } = intervalStats(valid);
  if (keepEmpty) {
    return {
      candles: clipOutliers(valid),
      skippedEmpty: false,
      intervalMs: nativeMs,
    };
  }
  const traded = valid.filter((c) => !isEmptyCandle(c));
  const useFiltered = traded.length >= MIN_TRADE_CANDLES;
  const candles = clipOutliers(useFiltered ? traded : valid);
  const first = candles[0];
  const last = candles[candles.length - 1];
  const spanMs = first && last ? candleMs(last.time) - candleMs(first.time) : 0;
  const expectedBuckets = nativeMs > 0 ? spanMs / nativeMs + 1 : candles.length;
  const skippedEmpty =
    (useFiltered && traded.length < valid.length) || expectedBuckets > candles.length * 1.35;
  return { candles, skippedEmpty, intervalMs: nativeMs };
}

/** Merge this buy's price into OHLCV when Gecko has not caught up yet. */
function applySpot(
  raw: Candle[],
  spot: { price: number; volumeUsd?: number; timeSec?: number },
): Candle[] {
  if (!finite(spot.price)) return raw;
  const candles = validCandles(raw);
  const vol = spot.volumeUsd && spot.volumeUsd > 0 ? spot.volumeUsd : 0;
  const nowSec = spot.timeSec ?? Math.floor(Date.now() / 1000);
  if (!candles.length) {
    return [{ time: nowSec, open: spot.price, high: spot.price, low: spot.price, close: spot.price, volume: vol }];
  }

  const last = candles[candles.length - 1]!;
  const { medianMs } = intervalStats(candles);
  const bucketSec = Math.floor(nowSec / (medianMs / 1000)) * (medianMs / 1000);
  const sameBucket = Math.abs(candleMs(last.time) - bucketSec * 1000) < medianMs / 2;

  if (sameBucket) {
    return [
      ...candles.slice(0, -1),
      {
        time: last.time,
        open: last.open,
        high: Math.max(last.high, spot.price),
        low: Math.min(last.low, spot.price),
        close: spot.price,
        volume: (last.volume || 0) + vol,
      },
    ];
  }

  if (nowSec * 1000 >= candleMs(last.time)) {
    const open = last.close;
    return [
      ...candles,
      {
        time: bucketSec,
        open,
        high: Math.max(open, spot.price),
        low: Math.min(open, spot.price),
        close: spot.price,
        volume: vol,
      },
    ];
  }

  return candles;
}

function priceWindow(candles: Candle[]): { min: number; max: number } {
  const samples = candles.flatMap((c) => [c.open, c.close, c.high, c.low]).sort((a, b) => a - b);
  let min = percentile(samples, 4);
  let max = percentile(samples, 96);
  if (max <= min) {
    min = Math.min(...samples);
    max = Math.max(...samples);
  }
  const pad = (max - min) * 0.14 || max * 0.04;
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
  if (ticks.length < 3) {
    ticks.length = 0;
    for (let i = 0; i <= count; i++) ticks.push(min + (span * i) / count);
  }
  return ticks;
}

export function renderChartPng(
  symbol: string,
  raw: Candle[],
  options: ChartRenderOptions = {},
): Buffer | null {
  registerInterFonts();
  const quote = options.quote?.trim() || "USD";
  const stamped = options.spot ? applySpot(raw, options.spot) : raw;
  const { candles, skippedEmpty, intervalMs } = selectPlotCandles(stamped, options.keepEmpty === true);
  if (candles.length < 2) return null;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  bg.addColorStop(0, C.bgTop);
  bg.addColorStop(1, C.bg);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const pad = { top: 78, right: 108, bottom: 44, left: 18 };
  const volH = 86;
  const gap = 12;
  const plotX = pad.left;
  const plotY = pad.top;
  const plotW = WIDTH - pad.left - pad.right;
  const plotH = HEIGHT - pad.top - pad.bottom - volH - gap;
  const volY = plotY + plotH + gap;

  ctx.fillStyle = C.pane;
  roundRect(ctx, plotX, plotY, plotW, plotH, 6);
  ctx.fill();
  roundRect(ctx, plotX, volY, plotW, volH, 6);
  ctx.fill();

  const { min, max } = priceWindow(candles);
  const span = max - min || 1;
  const volumes = candles.map((c) => c.volume || 0).sort((a, b) => a - b);
  const trueMaxVol = volumes[volumes.length - 1] ?? 0;
  const volScale = Math.max(percentile(volumes, 90) || trueMaxVol, trueMaxVol * 0.15, 1);
  const inner = 8;
  const slot = (plotW - inner * 2) / candles.length;
  const bodyW = Math.max(4, Math.min(18, slot * 0.72));

  const yFor = (price: number) => {
    const clipped = Math.min(max, Math.max(min, price));
    return plotY + ((max - clipped) / span) * plotH;
  };
  const xFor = (i: number) => plotX + inner + (i + 0.5) * slot;

  const ticks = niceTicks(min, max, 5);
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.font = font(11);
  ctx.fillStyle = C.axis;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const tick of ticks) {
    const y = yFor(tick);
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();
    ctx.fillText(formatPrice(tick), plotX + plotW + 10, y);
  }

  ctx.strokeStyle = C.paneBorder;
  ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);
  ctx.strokeRect(plotX + 0.5, volY + 0.5, plotW - 1, volH - 1);

  const last = candles[candles.length - 1]!;
  const first = candles[0]!;
  const lastUp = last.close >= last.open;
  const lastY = yFor(last.close);

  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = C.priceLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX, lastY);
  ctx.lineTo(plotX + plotW, lastY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (trueMaxVol > 0) {
    candles.forEach((candle, i) => {
      const vol = candle.volume || 0;
      if (vol <= 0) return;
      const x = xFor(i);
      const up = candle.close >= candle.open;
      const vh = Math.max(2, Math.min(volH - 18, (vol / volScale) * (volH - 18)));
      ctx.fillStyle = up ? C.volumeUp : C.volumeDown;
      ctx.fillRect(x - bodyW / 2, volY + volH - 6 - vh, bodyW, vh);
    });
  }

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const next = candles[i]!;
    const gapMs = candleMs(next.time) - candleMs(prev.time);
    if (gapMs <= intervalMs * 1.6) continue;
    const x0 = xFor(i - 1) + bodyW / 2 + 1;
    const x1 = xFor(i) - bodyW / 2 - 1;
    if (x1 - x0 < 8) continue;
    const up = prev.close >= prev.open;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = up ? "rgba(34, 197, 94, 0.55)" : "rgba(239, 68, 68, 0.55)";
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.moveTo(x0, yFor(prev.close));
    ctx.lineTo(x1, yFor(next.open));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  candles.forEach((candle, i) => {
    const x = xFor(i);
    const up = candle.close >= candle.open;
    const color = up ? C.up : C.down;
    ctx.strokeStyle = color;
    ctx.fillStyle = up ? C.upFill : C.downFill;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x, yFor(candle.high));
    ctx.lineTo(x, yFor(candle.low));
    ctx.stroke();
    const top = yFor(Math.max(candle.open, candle.close));
    const bot = yFor(Math.min(candle.open, candle.close));
    const h = Math.max(2, bot - top);
    ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    ctx.strokeRect(x - bodyW / 2 + 0.5, top + 0.5, Math.max(1, bodyW - 1), Math.max(1, h - 1));
  });

  const tagText = formatPrice(last.close);
  ctx.font = font(12, 700);
  const tagW = Math.max(72, ctx.measureText(tagText).width + 16);
  const tagH = 22;
  const tagX = plotX + plotW + 1;
  const tagY = Math.min(plotY + plotH - tagH - 2, Math.max(plotY + 2, lastY - tagH / 2));
  ctx.fillStyle = lastUp ? C.up : C.down;
  roundRect(ctx, tagX, tagY, tagW, tagH, 4);
  ctx.fill();
  ctx.fillStyle = C.tagText;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tagText, tagX + tagW / 2, tagY + tagH / 2 + 0.5);

  ctx.fillStyle = C.muted;
  ctx.font = font(11, 700);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Vol", plotX + 8, volY + 16);
  const volLabel = formatVolume(trueMaxVol);
  if (volLabel) {
    ctx.font = font(11);
    ctx.fillStyle = C.dim;
    ctx.fillText(volLabel, plotX + 36, volY + 16);
  }

  const change = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
  const up = change >= 0;
  const visibleHigh = Math.max(...candles.map((c) => c.high));
  const visibleLow = Math.min(...candles.map((c) => c.low));
  const tf = options.intervalLabel?.trim() || intervalLabelFromMs(intervalMs);
  const subtitleParts = [`${tf} · ${windowLabel(first, last)}`];
  if (skippedEmpty) subtitleParts.push("empty periods skipped");

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.title;
  ctx.font = font(24, 700);
  ctx.fillText(`${symbol} / ${quote}`, pad.left, 32);

  ctx.font = font(13);
  ctx.fillStyle = C.muted;
  ctx.fillText(subtitleParts.join(" · "), pad.left, 52);

  ctx.font = font(12, 700);
  ctx.fillStyle = C.up;
  ctx.fillText(`H ${formatPrice(visibleHigh)}`, pad.left, 70);
  const highW = ctx.measureText(`H ${formatPrice(visibleHigh)}`).width;
  ctx.fillStyle = C.down;
  ctx.fillText(`L ${formatPrice(visibleLow)}`, pad.left + highW + 16, 70);

  ctx.textAlign = "right";
  ctx.fillStyle = up ? C.up : C.down;
  ctx.font = font(26, 700);
  ctx.fillText(formatPrice(last.close), WIDTH - 18, 34);
  const pct = formatPct(change);
  ctx.font = font(14, 700);
  const pctW = ctx.measureText(pct).width + 16;
  ctx.fillStyle = up ? "rgba(34, 197, 94, 0.16)" : "rgba(239, 68, 68, 0.16)";
  roundRect(ctx, WIDTH - 18 - pctW, 42, pctW, 22, 6);
  ctx.fill();
  ctx.fillStyle = up ? C.up : C.down;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(pct, WIDTH - 18 - pctW / 2, 53);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.axis;
  ctx.font = font(12);
  const startLabel = formatDateTime(first.time);
  const endLabel = formatDateTime(last.time);
  ctx.fillText(startLabel, plotX, HEIGHT - 14);
  ctx.textAlign = "right";
  ctx.fillText(`${endLabel}  UTC`, plotX + plotW, HEIGHT - 14);
  ctx.textAlign = "center";
  ctx.fillStyle = C.dim;
  ctx.font = font(11);
  ctx.fillText("→", plotX + plotW / 2, HEIGHT - 14);

  ctx.textAlign = "left";
  ctx.fillStyle = C.dim;
  ctx.font = font(10);
  ctx.fillText(BOT_NAME, pad.left, volY - 3);

  return canvas.toBuffer("image/png");
}
