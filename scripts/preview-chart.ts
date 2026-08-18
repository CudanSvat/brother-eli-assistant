import { writeFileSync } from "node:fs";
import { GlobalFonts } from "@napi-rs/canvas";
import { renderChartPng } from "../src/chart/render.ts";
import { getMarketSnapshot, getOhlcv } from "../src/market/geckoterminal.ts";
import type { Candle } from "../src/types.ts";

const SLAY = "0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2";

function synthetic(): Candle[] {
  const now = Math.floor(Date.now() / 1000);
  const step = 15 * 60;
  const candles: Candle[] = [];
  let price = 0.000214;
  for (let i = 64; i >= 0; i--) {
    const time = now - i * step;
    const traded = i % 3 !== 0;
    if (!traded) {
      candles.push({ time, open: price, high: price, low: price, close: price, volume: 0 });
      continue;
    }
    const delta = (Math.sin(i / 4) + (i % 5) * 0.04 - 0.1) * 0.000004;
    const open = price;
    const close = Math.max(0.00005, price + delta);
    const high = Math.max(open, close) * 1.012;
    const low = Math.min(open, close) * 0.988;
    candles.push({ time, open, high, low, close, volume: 800 + i * 40 });
    price = close;
  }
  return candles;
}

const families = GlobalFonts.families.map((f) => f.family);
console.log("fonts has Inter:", GlobalFonts.has("Inter"));
console.log(
  "Inter styles:",
  GlobalFonts.families.find((f) => f.family === "Inter")?.styles ?? "missing",
);
if (!families.includes("Inter")) {
  console.warn("Inter not in families:", families.slice(0, 12));
}

let symbol = "SLAY";
let candles: Candle[] = [];
try {
  const market = await getMarketSnapshot(SLAY);
  candles = await getOhlcv(market?.pairAddress);
  console.log("gecko pair", market?.pairAddress ?? "none", "candles", candles.length);
} catch (error) {
  console.warn("live ohlcv failed:", error);
}

if (candles.length < 8) {
  console.log("using synthetic candles");
  candles = synthetic();
}

const png = renderChartPng(symbol, candles, { quote: "USD" });
if (!png) {
  console.error("renderChartPng returned null");
  process.exit(1);
}
writeFileSync("chart-preview.png", png);
console.log("wrote chart-preview.png", png.length, "bytes");
