import { feltToBigInt, normalizeAddress, parseI129 } from "../lib/format.ts";
import type { DecodedSwap, PoolKey } from "../types.ts";

class FeltReader {
  private i = 0;
  constructor(private readonly felts: bigint[]) {}

  remaining(): number {
    return this.felts.length - this.i;
  }

  peek(): bigint {
    return this.felts[this.i] ?? 0n;
  }

  next(): bigint {
    const value = this.felts[this.i] ?? 0n;
    this.i += 1;
    return value;
  }

  address(): string {
    return normalizeAddress(`0x${this.next().toString(16)}`);
  }

  i129(): bigint {
    const mag = this.next();
    const sign = this.next();
    return parseI129(mag, sign);
  }

  u256(): bigint {
    const low = this.next();
    const high = this.next();
    return low + (high << 128n);
  }
}

function toFelts(values: readonly (string | number | bigint)[]): bigint[] {
  return values.map((value) => feltToBigInt(value));
}

function readPoolKey(reader: FeltReader): PoolKey {
  return {
    token0: reader.address(),
    token1: reader.address(),
    fee: reader.next(),
    tickSpacing: reader.next(),
    extension: reader.address(),
  };
}

/**
 * Ekubo Core `Swapped` layout:
 * locker, pool_key, params (i129, is_token1, u256, skip_ahead),
 * delta (i129, i129), sqrt_ratio_after u256, tick_after i129, liquidity_after u128
 *
 * Core reports locker-vs-pool deltas with the opposite sign of user flow:
 * negative token delta = Core paid the locker = user received it (buy).
 * We negate so the rest of the bot can treat positive = user received.
 */
export function decodeSwapped(event: {
  keys?: readonly (string | number | bigint)[];
  data?: readonly (string | number | bigint)[];
  transaction_hash: string;
  block_number?: number;
  blockNumber?: number;
}): DecodedSwap {
  const keys = toFelts(event.keys ?? []);
  const data = toFelts(event.data ?? []);
  const extraKeys = keys.slice(1);
  const stream = extraKeys.length && extraKeys.length < 8 ? [...extraKeys, ...data] : data;
  const reader = new FeltReader(stream.length ? stream : data);

  const locker = reader.address();
  const poolKey = readPoolKey(reader);

  // SwapParameters: amount i129, is_token1, sqrt_ratio_limit u256, skip_ahead
  reader.i129();
  reader.next();
  if (reader.remaining() >= 12) {
    reader.u256();
  } else {
    reader.next();
  }
  reader.next();

  const delta0 = -reader.i129();
  const delta1 = -reader.i129();
  const sqrtRatioAfter = reader.remaining() >= 2 ? reader.u256() : null;

  return {
    locker,
    poolKey,
    delta0,
    delta1,
    sqrtRatioAfter,
    transactionHash: normalizeAddress(event.transaction_hash),
    blockNumber: event.block_number ?? event.blockNumber ?? 0,
  };
}
