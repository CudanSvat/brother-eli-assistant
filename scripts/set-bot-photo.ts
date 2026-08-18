import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const srcPng = path.resolve("assets/brother-eli.png");
const destJpg = path.resolve("assets/brother-eli.jpg");

async function toJpeg(): Promise<void> {
  const image = await loadImage(srcPng);
  const size = Math.min(image.width, image.height);
  const sx = Math.floor((image.width - size) / 2);
  const sy = Math.floor((image.height - size) / 2);
  const out = 640;
  const canvas = createCanvas(out, out);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out, out);
  ctx.drawImage(image, sx, sy, size, size, 0, 0, out, out);
  fs.writeFileSync(destJpg, canvas.toBuffer("image/jpeg", 92));
}

async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }
  await toJpeg();
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  await bot.api.setMyProfilePhoto({
    type: "static",
    photo: new InputFile(destJpg),
  });
  console.log("Profile photo set from assets/brother-eli.jpg");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
