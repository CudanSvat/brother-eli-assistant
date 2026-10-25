import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import type { WheelOutcome } from "./outcome.ts";
import type { WheelCompositionId } from "./variants.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.resolve(here, "../../video");
const RENDER_TIMEOUT_MS = 180_000;

export interface WheelVideoProps {
  title: string;
  subtitle: string;
  players: string[];
  winner: string;
  prizeLine: string;
  hasWinner: boolean;
  winnerImageUrl: string | null;
}

function propsFromOutcome(outcome: WheelOutcome): WheelVideoProps {
  const winnerImageUrl =
    outcome.hasWinner && outcome.tokenId != null
      ? `${config.eliSiteOrigin}/nft/images/${outcome.tokenId}.png`
      : null;
  return {
    title: "Brother Eli Wheel",
    subtitle: "Daily $SLAY spin",
    players: outcome.reelLabels,
    winner: outcome.winnerLabel,
    prizeLine: outcome.hasWinner ? `${outcome.prizeSlay} SLAY` : "No prize today",
    hasWinner: outcome.hasWinner,
    winnerImageUrl,
  };
}

function runRender(
  inputPath: string,
  outputPath: string,
  compositionId: WheelCompositionId,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "tsx",
        "src/render.ts",
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--composition",
        compositionId,
      ],
      {
        cwd: VIDEO_DIR,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    let stderr = "";
    child.stdout?.on("data", (buf: Buffer) => {
      const line = buf.toString();
      if (line.trim()) console.log(`[wheel-render] ${line.trimEnd()}`);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Wheel render timed out after ${RENDER_TIMEOUT_MS}ms`));
    }, RENDER_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Wheel render exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Pre-render a Remotion wheel MP4 for this outcome + composition.
 */
export async function renderWheelVideo(
  outcome: WheelOutcome,
  compositionId: WheelCompositionId = "CobaltReel",
): Promise<string | null> {
  if (!existsSync(path.join(VIDEO_DIR, "package.json"))) {
    console.warn("Wheel video package missing (video/package.json)");
    return null;
  }
  if (!existsSync(path.join(VIDEO_DIR, "node_modules"))) {
    console.warn("Wheel video deps missing — run npm install in video/");
    return null;
  }

  const outDir = path.join(os.tmpdir(), "slay-wheel");
  mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const inputPath = path.join(outDir, `wheel-${stamp}.json`);
  const outputPath = path.join(outDir, `wheel-${stamp}.mp4`);
  writeFileSync(inputPath, JSON.stringify(propsFromOutcome(outcome)));

  try {
    await runRender(inputPath, outputPath, compositionId);
    if (!existsSync(outputPath)) return null;
    return outputPath;
  } catch (error) {
    console.warn("Wheel video render failed:", error);
    return null;
  }
}
