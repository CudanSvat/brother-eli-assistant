/**
 * CLI: npx tsx src/render.ts --input data.json --output out.mp4 --composition WheelOfFortune
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_CACHE_DIR = path.join(os.tmpdir(), "slay_wheel_remotion_bundle");
const BUNDLE_META_FILE = path.join(BUNDLE_CACHE_DIR, "meta.json");

function hashSources(srcDir: string): string {
  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .sort()
    .map((f) => fs.readFileSync(path.join(srcDir, f)));
  return crypto.createHash("md5").update(Buffer.concat(files)).digest("hex");
}

async function getOrCreateBundle(entryPoint: string): Promise<string> {
  const srcDir = path.dirname(entryPoint);
  const currentHash = hashSources(srcDir);

  if (fs.existsSync(BUNDLE_META_FILE)) {
    const meta = JSON.parse(fs.readFileSync(BUNDLE_META_FILE, "utf-8")) as {
      hash?: string;
      bundlePath?: string;
    };
    if (meta.hash === currentHash && meta.bundlePath && fs.existsSync(meta.bundlePath)) {
      console.log(`Reusing cached bundle (${currentHash.slice(0, 8)})`);
      return meta.bundlePath;
    }
  }

  fs.mkdirSync(BUNDLE_CACHE_DIR, { recursive: true });
  console.log("Bundling Remotion project…");
  const bundlePath = await bundle({
    entryPoint,
    webpackOverride: (config) => config,
    outDir: BUNDLE_CACHE_DIR,
  });
  fs.writeFileSync(BUNDLE_META_FILE, JSON.stringify({ hash: currentHash, bundlePath }));
  return bundlePath;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const outputIdx = args.indexOf("--output");
  const compositionIdx = args.indexOf("--composition");

  if (inputIdx === -1 || outputIdx === -1) {
    console.error(
      "Usage: npx tsx src/render.ts --input data.json --output out.mp4 [--composition WheelOfFortune]",
    );
    process.exit(1);
  }

  const inputFile = args[inputIdx + 1]!;
  const outputFile = args[outputIdx + 1]!;
  const compositionId = compositionIdx !== -1 ? args[compositionIdx + 1]! : "WheelOfFortune";

  if (!fs.existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const inputProps = JSON.parse(fs.readFileSync(inputFile, "utf-8")) as Record<string, unknown>;
  const bundled = await getOrCreateBundle(path.resolve(__dirname, "./index.ts"));

  console.log(`Selecting composition: ${compositionId}`);
  const composition = await selectComposition({
    serveUrl: bundled,
    id: compositionId,
    inputProps,
  });

  console.log(`Rendering ${composition.durationInFrames} frames…`);
  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: outputFile,
    inputProps,
  });

  console.log(`Video saved to ${outputFile}`);
}

main().catch((err) => {
  console.error("Render failed:", err);
  process.exit(1);
});
