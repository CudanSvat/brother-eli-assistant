import { SLAY_ATH_USD, SLAY_TOKEN } from "../config.ts";
import { normalizeAddress } from "../lib/format.ts";
import { getPoolAthUsd } from "../market/geckoterminal.ts";
import type { TokenSettings } from "../types.ts";

export interface AthCheck {
  nextAth: number;
  newAth: boolean;
  previousAth: number | null;
}

/** Hardcoded ATH floors for tokens whose real high predates public OHLCV. */
export function manualAthFloor(tokenAddress: string): number | null {
  if (normalizeAddress(tokenAddress) === normalizeAddress(SLAY_TOKEN)) {
    return SLAY_ATH_USD;
  }
  return null;
}

function applyAthFloor(tokenAddress: string, ath: number | null | undefined): number | null {
  const floor = manualAthFloor(tokenAddress);
  const values = [ath, floor].filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (!values.length) return null;
  return Math.max(...values);
}

/**
 * Authoritative ATH from the pinned Gecko pool (+ manual floor).
 * Prefer pool history over a stale/low stored mark so "NEW ATH" is not
 * announced against the first buy we happened to see.
 */
export async function seedAthUsd(
  tokenAddress: string,
  pairAddress: string | null | undefined,
  storedAth?: number | null,
): Promise<number | null> {
  let geckoAth: number | null = null;
  if (pairAddress) {
    geckoAth = await getPoolAthUsd(pairAddress);
  }
  // Trust Gecko when we have it; only fall back to stored if history is missing.
  const ath = geckoAth ?? storedAth ?? null;
  return applyAthFloor(tokenAddress, ath);
}

function maxAth(...values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (!nums.length) return null;
  return Math.max(...nums);
}

export async function checkBuyAth(
  token: TokenSettings,
  pairAddress: string | null,
  chartUsd: number | null,
): Promise<AthCheck | null> {
  if (chartUsd == null || !Number.isFinite(chartUsd) || chartUsd <= 0) return null;

  // Merge stored mark with pool history so a missed seed can't false-trigger ATH.
  let geckoAth: number | null = null;
  if (pairAddress) {
    try {
      geckoAth = await getPoolAthUsd(pairAddress);
    } catch {
      geckoAth = null;
    }
  }
  let previousAth = applyAthFloor(token.address, maxAth(token.athPriceUsd, geckoAth));

  if (previousAth == null || previousAth <= 0) {
    return { nextAth: chartUsd, newAth: false, previousAth: null };
  }

  const newAth = chartUsd > previousAth * 1.000001;
  return {
    nextAth: Math.max(previousAth, chartUsd),
    newAth,
    previousAth,
  };
}

/** Whether this buy should get the ATH badge/GIF and may bypass the regular min. */
export function shouldAnnounceAth(
  token: TokenSettings,
  usdValue: number,
  priceHitAth: boolean,
): boolean {
  if (!priceHitAth) return false;
  if (token.athMinUsd == null) return false;
  return usdValue >= token.athMinUsd;
}
