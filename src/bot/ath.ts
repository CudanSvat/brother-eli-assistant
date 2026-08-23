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

export async function seedAthUsd(
  tokenAddress: string,
  pairAddress: string | null | undefined,
  storedAth?: number | null,
): Promise<number | null> {
  let ath = storedAth ?? null;
  if (ath == null && pairAddress) {
    ath = await getPoolAthUsd(pairAddress);
  }
  return applyAthFloor(tokenAddress, ath);
}

export async function checkBuyAth(
  token: TokenSettings,
  pairAddress: string | null,
  chartUsd: number | null,
): Promise<AthCheck | null> {
  if (chartUsd == null || !Number.isFinite(chartUsd) || chartUsd <= 0) return null;

  let previousAth = token.athPriceUsd;
  if (previousAth == null && pairAddress) {
    previousAth = await getPoolAthUsd(pairAddress);
  }
  previousAth = applyAthFloor(token.address, previousAth);

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
