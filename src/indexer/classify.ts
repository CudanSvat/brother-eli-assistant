import { addressesEqual, isQuoteToken, normalizeAddress } from "../lib/format.ts";
import type { ClassifiedSwap, DecodedSwap } from "../types.ts";

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function addNet(net: Map<string, bigint>, address: string, delta: bigint): void {
  const key = normalizeAddress(address);
  net.set(key, (net.get(key) ?? 0n) + delta);
}

export function hopTouchesToken(swap: DecodedSwap, trackedAddress: string): boolean {
  return (
    addressesEqual(swap.poolKey.token0, trackedAddress) ||
    addressesEqual(swap.poolKey.token1, trackedAddress)
  );
}

/**
 * Classify a single pool hop against a tracked token.
 * Delta is locker vs Core: positive = user received the token (buy).
 */
export function classifyHop(
  swap: DecodedSwap,
  trackedAddress: string,
): ClassifiedSwap | null {
  const { token0, token1 } = swap.poolKey;
  const matches0 = addressesEqual(token0, trackedAddress);
  const matches1 = addressesEqual(token1, trackedAddress);
  if (matches0 === matches1) return null;

  const tokenDelta = matches0 ? swap.delta0 : swap.delta1;
  const quoteDelta = matches0 ? swap.delta1 : swap.delta0;
  const quoteAddress = matches0 ? token1 : token0;
  if (tokenDelta === 0n) return null;

  const side = tokenDelta > 0n ? "buy" : "sell";
  const quoteAmount = abs(quoteDelta);
  return {
    side,
    tokenAddress: trackedAddress,
    tokenAmount: abs(tokenDelta),
    quoteAddress,
    quoteAmount,
    paidLegs: [{ address: quoteAddress, amount: quoteAmount }],
    transactionHash: swap.transactionHash,
    blockNumber: swap.blockNumber,
    locker: swap.locker,
    hopCount: 1,
  };
}

/**
 * Collapse an AVNU/Fibrous split route into one fill.
 *
 * Aggregators execute one user swap as several Ekubo hops in the same tx
 * (e.g. 40% ETH→TOKEN, 60% ETH→STRK→TOKEN). Intermediate tokens net near
 * zero; the user only paid the source quote and received the tracked token.
 */
export function netTransaction(
  hops: DecodedSwap[],
  trackedAddress: string,
): ClassifiedSwap | null {
  if (!hops.length) return null;

  const tracked = normalizeAddress(trackedAddress);
  const involving = hops.filter((hop) => hopTouchesToken(hop, tracked));
  if (!involving.length) return null;

  const net = new Map<string, bigint>();
  for (const hop of hops) {
    addNet(net, hop.poolKey.token0, hop.delta0);
    addNet(net, hop.poolKey.token1, hop.delta1);
  }

  const tokenNet = net.get(tracked) ?? 0n;
  if (tokenNet === 0n) return null;

  const side = tokenNet > 0n ? "buy" : "sell";
  const tokenAmount = abs(tokenNet);

  const paidLegs: { address: string; amount: bigint }[] = [];
  let quoteAddress = involving[0]!.poolKey.token0;
  let quoteAmount = 0n;
  let bestScore = -1n;

  for (const [address, amount] of net) {
    if (address === tracked) continue;
    const paid = side === "buy" ? amount < 0n : amount > 0n;
    if (!paid) continue;
    const size = abs(amount);
    paidLegs.push({ address, amount: size });
    const score = (isQuoteToken(address) ? 1n << 128n : 0n) + size;
    if (score > bestScore) {
      bestScore = score;
      quoteAddress = address;
      quoteAmount = size;
    }
  }

  const last = involving[involving.length - 1]!;
  return {
    side,
    tokenAddress: tracked,
    tokenAmount,
    quoteAddress,
    quoteAmount,
    paidLegs,
    transactionHash: last.transactionHash,
    blockNumber: last.blockNumber,
    locker: last.locker,
    hopCount: hops.length,
  };
}
