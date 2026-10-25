import { WHEEL_PRIZE_WEIGHTS } from "../config.ts";
import type { EliHolderRow } from "../store/db.ts";

export interface WheelOutcome {
  hasWinner: boolean;
  tokenId: number | null;
  ownerAddress: string | null;
  prizeSlay: number | null;
  /** Labels shown on the reel (NFT tags + prize hints). */
  reelLabels: string[];
  /** What the reel stops on. */
  winnerLabel: string;
}

function prizeLabels(): string[] {
  return WHEEL_PRIZE_WEIGHTS.map((t) => `${t.prizeSlay} SLAY`);
}

function pickWeightedPrize(): number {
  const total = WHEEL_PRIZE_WEIGHTS.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * total;
  for (const tier of WHEEL_PRIZE_WEIGHTS) {
    roll -= tier.weight;
    if (roll <= 0) return tier.prizeSlay;
  }
  return WHEEL_PRIZE_WEIGHTS[WHEEL_PRIZE_WEIGHTS.length - 1]!.prizeSlay;
}

function sampleLabels(holders: EliHolderRow[], count: number): string[] {
  if (!holders.length) return ["Eli #?", "Eli #?", "Eli #?"];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const h = holders[Math.floor(Math.random() * holders.length)]!;
    out.push(`Eli #${h.tokenId}`);
  }
  return out;
}

/** 50/50 winner; if yes, uniform NFT + weighted prize. */
export function rollWheelOutcome(holders: EliHolderRow[]): WheelOutcome {
  const hasWinner = Math.random() < 0.5;
  const prizes = prizeLabels();
  const reelLabels = sampleLabels(holders, Math.min(24, Math.max(8, holders.length)));

  if (!hasWinner || !holders.length) {
    return {
      hasWinner: false,
      tokenId: null,
      ownerAddress: null,
      prizeSlay: null,
      reelLabels: [...reelLabels, ...prizes],
      winnerLabel: "No winner",
    };
  }

  const pick = holders[Math.floor(Math.random() * holders.length)]!;
  const prizeSlay = pickWeightedPrize();
  return {
    hasWinner: true,
    tokenId: pick.tokenId,
    ownerAddress: pick.ownerAddress,
    prizeSlay,
    reelLabels: [...reelLabels, ...prizes],
    winnerLabel: `Eli #${pick.tokenId}`,
  };
}
