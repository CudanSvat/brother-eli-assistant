import { WHEEL_PRIZE_WEIGHTS, type WheelPrizeTier } from "../config.ts";
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

export interface RollWheelOptions {
  /** Launch-day: always pick a winner. */
  forceWin?: boolean;
  /** Launch-day: drop the smallest prize tier (reweight the rest). */
  dropSmallestPrize?: boolean;
}

/** On-chain collection display name. */
export function eliNftLabel(tokenId: number | string): string {
  return `Brother Eli Bald Kings #${tokenId}`;
}

function activeTiers(opts?: RollWheelOptions): WheelPrizeTier {
  let tiers = [...WHEEL_PRIZE_WEIGHTS];
  if (opts?.dropSmallestPrize && tiers.length > 1) {
    const min = Math.min(...tiers.map((t) => t.prizeSlay));
    tiers = tiers.filter((t) => t.prizeSlay !== min);
  }
  return tiers;
}

function prizeLabels(tiers: WheelPrizeTier): string[] {
  return tiers.map((t) => `${t.prizeSlay} SLAY`);
}

function pickWeightedPrize(tiers: WheelPrizeTier): number {
  const total = tiers.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * total;
  for (const tier of tiers) {
    roll -= tier.weight;
    if (roll <= 0) return tier.prizeSlay;
  }
  return tiers[tiers.length - 1]!.prizeSlay;
}

function sampleLabels(holders: EliHolderRow[], count: number): string[] {
  if (!holders.length) return [eliNftLabel("?"), eliNftLabel("?"), eliNftLabel("?")];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const h = holders[Math.floor(Math.random() * holders.length)]!;
    out.push(eliNftLabel(h.tokenId));
  }
  return out;
}

/** 50/50 winner (unless forceWin); if yes, uniform NFT + weighted prize. */
export function rollWheelOutcome(
  holders: EliHolderRow[],
  opts?: RollWheelOptions,
): WheelOutcome {
  const tiers = activeTiers(opts);
  const hasWinner = opts?.forceWin ? true : Math.random() < 0.5;
  const prizes = prizeLabels(tiers);
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
  const prizeSlay = pickWeightedPrize(tiers);
  return {
    hasWinner: true,
    tokenId: pick.tokenId,
    ownerAddress: pick.ownerAddress,
    prizeSlay,
    reelLabels: [...reelLabels, ...prizes],
    winnerLabel: eliNftLabel(pick.tokenId),
  };
}
