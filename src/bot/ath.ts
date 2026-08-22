import { getPoolAthUsd } from "../market/geckoterminal.ts";
import type { TokenSettings } from "../types.ts";

export interface AthCheck {
  nextAth: number;
  newAth: boolean;
  previousAth: number | null;
}

export async function checkBuyAth(
  token: TokenSettings,
  pairAddress: string | null,
  execPrice: number | null,
): Promise<AthCheck | null> {
  if (execPrice == null || !Number.isFinite(execPrice) || execPrice <= 0) return null;

  let previousAth = token.athPriceUsd;
  if (previousAth == null && pairAddress) {
    previousAth = await getPoolAthUsd(pairAddress);
  }

  if (previousAth == null || previousAth <= 0) {
    return { nextAth: execPrice, newAth: false, previousAth: null };
  }

  const newAth = execPrice > previousAth * 1.000001;
  return {
    nextAth: Math.max(previousAth, execPrice),
    newAth,
    previousAth,
  };
}
