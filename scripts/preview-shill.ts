import { writeFileSync } from "node:fs";
import { loadShillImage, renderShillCardPng } from "../src/chart/shill-card.ts";
import { getLaunchpadTokenByAddress, searchLaunchpadToken } from "../src/market/launchpad.ts";
import { SLAY_TOKEN } from "../src/config.ts";

async function main(): Promise<void> {
  const coin =
    (await searchLaunchpadToken("DEGENZ")) ?? (await getLaunchpadTokenByAddress(SLAY_TOKEN));
  if (!coin) {
    console.error("No launchpad token found for preview");
    process.exit(1);
  }

  const image = await loadShillImage(coin.logo);
  console.log(
    "coin:",
    coin.symbol,
    coin.name,
    "logo:",
    coin.logo ? "ok" : "none",
    image ? `${image.width}x${image.height}` : "no image",
  );

  const png = await renderShillCardPng({
    symbol: coin.symbol,
    name: coin.name,
    address: coin.address,
    image,
    priceUsd: coin.priceUsd,
    marketCap: coin.marketCap,
    volumeUsd: coin.volumeUsd,
    change24h: coin.change24h,
    holders: coin.holders,
    at: new Date("2026-10-21T12:00:00Z"),
  });

  writeFileSync("shill-preview.png", png);
  console.log("wrote shill-preview.png", png.length, "bytes");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
