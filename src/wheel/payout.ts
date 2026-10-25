import { Account, RpcProvider, cairo, CallData, uint256 } from "starknet";
import { SLAY_TOKEN, STRK_TOKEN, config } from "../config.ts";
import { normalizeAddress, shortAddress } from "../lib/format.ts";

const SLAY_DECIMALS = 18;
const STRK_DECIMALS = 18;

function tipAccount(provider: RpcProvider): Account {
  if (!config.slayTipAccountAddress || !config.slayTipPrivateKey) {
    throw new Error("Missing SLAY_TIP_ACCOUNT_ADDRESS / SLAY_TIP_PRIVATE_KEY");
  }
  return new Account({
    provider,
    address: normalizeAddress(config.slayTipAccountAddress),
    signer: config.slayTipPrivateKey,
  });
}

async function erc20Balance(
  provider: RpcProvider,
  token: string,
  owner: string,
): Promise<bigint> {
  try {
    const result = await provider.callContract({
      contractAddress: normalizeAddress(token),
      entrypoint: "balance_of",
      calldata: [normalizeAddress(owner)],
    });
    const low = BigInt(result[0] ?? "0");
    const high = BigInt(result[1] ?? "0");
    return low + (high << 128n);
  } catch {
    // Some tokens use balanceOf
    try {
      const result = await provider.callContract({
        contractAddress: normalizeAddress(token),
        entrypoint: "balanceOf",
        calldata: [normalizeAddress(owner)],
      });
      return uint256.uint256ToBN({ low: result[0] ?? "0", high: result[1] ?? "0" });
    } catch (error) {
      console.warn("Tip wallet balance read failed:", error);
      return 0n;
    }
  }
}

function rawToUnits(raw: bigint, decimals: number): number {
  if (raw <= 0n) return 0;
  return Number(raw) / 10 ** decimals;
}

export interface TipWalletStatus {
  configured: boolean;
  live: boolean;
  address: string | null;
  short: string | null;
  slayBalance: number | null;
  strkBalance: number | null;
  error?: string;
}

export async function getTipWalletStatus(provider: RpcProvider): Promise<TipWalletStatus> {
  const address = config.slayTipAccountAddress
    ? normalizeAddress(config.slayTipAccountAddress)
    : null;
  if (!address || !config.slayTipPrivateKey) {
    return {
      configured: false,
      live: config.wheelLive,
      address: address,
      short: address ? shortAddress(address) : null,
      slayBalance: null,
      strkBalance: null,
      error: "Tip wallet address/key not set",
    };
  }
  try {
    const [slayRaw, strkRaw] = await Promise.all([
      erc20Balance(provider, SLAY_TOKEN, address),
      erc20Balance(provider, STRK_TOKEN, address),
    ]);
    return {
      configured: true,
      live: config.wheelLive,
      address,
      short: shortAddress(address),
      slayBalance: rawToUnits(slayRaw, SLAY_DECIMALS),
      strkBalance: rawToUnits(strkRaw, STRK_DECIMALS),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      configured: true,
      live: config.wheelLive,
      address,
      short: shortAddress(address),
      slayBalance: null,
      strkBalance: null,
      error: msg,
    };
  }
}

export async function sendSlayPrize(
  provider: RpcProvider,
  recipient: string,
  prizeSlay: number,
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  if (!config.wheelLive) {
    return { ok: false, error: "WHEEL_LIVE is off (dry-run)" };
  }
  if (!config.slayTipAccountAddress || !config.slayTipPrivateKey) {
    return { ok: false, error: "Missing SLAY_TIP_ACCOUNT_ADDRESS / SLAY_TIP_PRIVATE_KEY" };
  }
  if (!Number.isFinite(prizeSlay) || prizeSlay <= 0) {
    return { ok: false, error: "Invalid prize amount" };
  }

  const to = normalizeAddress(recipient);
  const amountRaw = BigInt(Math.round(prizeSlay * 10 ** SLAY_DECIMALS));

  try {
    const tipAddr = normalizeAddress(config.slayTipAccountAddress);
    const bal = await erc20Balance(provider, SLAY_TOKEN, tipAddr);
    if (bal < amountRaw) {
      return {
        ok: false,
        error: `Tip wallet SLAY too low (have ${rawToUnits(bal, SLAY_DECIMALS)}, need ${prizeSlay})`,
      };
    }

    const account = tipAccount(provider);
    const amount = cairo.uint256(amountRaw);
    const calldata = CallData.compile({
      recipient: to,
      amount,
    });
    console.log(
      `Wheel payout: ${prizeSlay} SLAY → ${shortAddress(to)} from ${shortAddress(tipAddr)}`,
    );
    const result = await account.execute([
      {
        contractAddress: normalizeAddress(SLAY_TOKEN),
        entrypoint: "transfer",
        calldata,
      },
    ]);
    const hash = result.transaction_hash;
    await provider.waitForTransaction(hash);
    console.log(`Wheel payout ok: ${hash}`);
    return { ok: true, txHash: hash };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("Wheel SLAY transfer failed:", error);
    return { ok: false, error: msg };
  }
}
