import { createCanvas } from "@napi-rs/canvas";
import { BOT_NAME } from "../config.ts";
import type { Candle } from "../types.ts";

const WIDTH = 800;
const HEIGHT = 400;
const PAD = { top: 36, right: 18, bottom: 32, left: 18 };

export function renderChartPng(symbol: string, candles: Candle[]): Buffer | null {
  if (candles.length < 2) return null;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0b1020";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min || 1;
  const candleW = Math.max(4, (plotW / candles.length) * 0.72);

  const yFor = (price: number) => PAD.top + ((max - price) / span) * plotH;
  const xFor = (i: number) => PAD.left + (i + 0.5) * (plotW / candles.length);

  ctx.strokeStyle = "#1c2744";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(WIDTH - PAD.right, y);
    ctx.stroke();
  }

  const last = candles[candles.length - 1]!;
  ctx.strokeStyle = "#2a3558";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(PAD.left, yFor(last.close));
  ctx.lineTo(WIDTH - PAD.right, yFor(last.close));
  ctx.stroke();
  ctx.setLineDash([]);

  candles.forEach((candle, i) => {
    const x = xFor(i);
    const up = candle.close >= candle.open;
    ctx.strokeStyle = up ? "#3dd68c" : "#ff5d73";
    ctx.fillStyle = up ? "#3dd68c" : "#ff5d73";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, yFor(candle.high));
    ctx.lineTo(x, yFor(candle.low));
    ctx.stroke();
    const bodyTop = yFor(Math.max(candle.open, candle.close));
    const bodyBot = yFor(Math.min(candle.open, candle.close));
    const h = Math.max(1, bodyBot - bodyTop);
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, h);
  });

  const first = candles[0]!;
  const up = last.close >= first.open;
  ctx.fillStyle = "#e8eefc";
  ctx.font = "600 20px sans-serif";
  ctx.fillText(`${symbol} · 5m`, PAD.left, 26);
  ctx.fillStyle = up ? "#3dd68c" : "#ff5d73";
  ctx.font = "600 18px sans-serif";
  const change = ((last.close - first.open) / first.open) * 100;
  const label = `${last.close < 1 ? last.close.toPrecision(4) : last.close.toFixed(4)}  ${
    change >= 0 ? "+" : ""
  }${change.toFixed(1)}%`;
  ctx.fillText(label, WIDTH - PAD.right - ctx.measureText(label).width, 26);

  ctx.fillStyle = "#8b93a7";
  ctx.font = "12px sans-serif";
  ctx.fillText(BOT_NAME, PAD.left, HEIGHT - 10);

  return canvas.toBuffer("image/png");
}
