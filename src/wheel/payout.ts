import { Account, RpcProvider, cairo, CallData, uint256 } from "starknet";
import { SLAY_TOKEN, STRK_TOKEN, config } from "../config.ts";
import { escapeHtml, normalizeAddress, shortAddress } from "../lib/format.ts";
import { voyagerTxUrl } from "../market/ekubo.ts";
import {
  claimWheelPayout,
  getWheelSpin,
  updateWheelSpin,
  type WheelSpinRow,
} from "../store/db.ts";

const SLAY_DECIMALS = 18;
const STRK_DECIMALS = 18;
/** Refuse payout if tip wallet STRK is below this (gas). */
const MIN_STRK_GAS = 0.5;

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
    const [slayBal, strkBal] = await Promise.all([
      erc20Balance(provider, SLAY_TOKEN, tipAddr),
      erc20Balance(provider, STRK_TOKEN, tipAddr),
    ]);
    if (rawToUnits(strkBal, STRK_DECIMALS) < MIN_STRK_GAS) {
      return {
        ok: false,
        error: `Tip wallet STRK too low for gas (have ${rawToUnits(strkBal, STRK_DECIMALS).toFixed(4)}, need ≥${MIN_STRK_GAS})`,
      };
    }
    if (slayBal < amountRaw) {
      return {
        ok: false,
        error: `Tip wallet SLAY too low (have ${rawToUnits(slayBal, SLAY_DECIMALS)}, need ${prizeSlay})`,
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

export type SettleResult =
  | { kind: "paid"; spin: WheelSpinRow; txHash: string; voyagerUrl: string }
  | { kind: "already_paid"; spin: WheelSpinRow; txHash: string; voyagerUrl: string }
  | { kind: "dry_run"; spin: WheelSpinRow }
  | { kind: "skipped"; spin: WheelSpinRow; reason: string }
  | { kind: "failed"; spin: WheelSpinRow; error: string }
  | { kind: "busy"; reason: string };

/**
 * Idempotent payout for one spin. Safe to call from spin flow or /wheel_retry.
 * Never sends twice once tx_hash is stored.
 */
export async function settleWheelPayout(
  provider: RpcProvider,
  spinId: number,
): Promise<SettleResult> {
  const current = getWheelSpin(spinId);
  if (!current) return { kind: "busy", reason: "Spin not found" };

  if (current.txHash) {
    return {
      kind: "already_paid",
      spin: current,
      txHash: current.txHash,
      voyagerUrl: voyagerTxUrl(current.txHash),
    };
  }
  if (current.status === "paid") {
    return { kind: "busy", reason: "Spin already marked paid" };
  }
  if (!current.hasWinner || !current.ownerAddress || current.prizeSlay == null) {
    return { kind: "skipped", spin: current, reason: "No winner / missing payout fields" };
  }

  if (!config.wheelLive) {
    const spin = updateWheelSpin(spinId, { status: "dry_run", error: null }) ?? current;
    return { kind: "dry_run", spin };
  }

  const claimed = claimWheelPayout(spinId);
  if (!claimed) {
    const again = getWheelSpin(spinId);
    if (again?.txHash) {
      return {
        kind: "already_paid",
        spin: again,
        txHash: again.txHash,
        voyagerUrl: voyagerTxUrl(again.txHash),
      };
    }
    return { kind: "busy", reason: "Payout already in progress or not retryable" };
  }

  const pay = await sendSlayPrize(provider, claimed.ownerAddress!, claimed.prizeSlay!);
  if (pay.ok) {
    const spin =
      updateWheelSpin(spinId, { status: "paid", txHash: pay.txHash, error: null }) ?? claimed;
    return {
      kind: "paid",
      spin,
      txHash: pay.txHash,
      voyagerUrl: voyagerTxUrl(pay.txHash),
    };
  }

  const spin =
    updateWheelSpin(spinId, { status: "failed", error: pay.error }) ?? claimed;
  return { kind: "failed", spin, error: pay.error };
}

export function payoutCaptionNote(result: SettleResult): string {
  switch (result.kind) {
    case "paid":
      return `Paid <b>${result.spin.prizeSlay} SLAY</b> · <a href="${result.voyagerUrl}">Voyager</a>`;
    case "already_paid":
      return `Already paid <b>${result.spin.prizeSlay} SLAY</b> · <a href="${result.voyagerUrl}">Voyager</a>`;
    case "dry_run":
      return `<i>Dry-run:</i> would send <b>${result.spin.prizeSlay} SLAY</b> to <code>${escapeHtml(result.spin.ownerAddress ?? "")}</code>.`;
    case "failed":
      return `Payout delayed — the team was notified.`;
    case "skipped":
      return escapeHtml(result.reason);
    case "busy":
      return escapeHtml(result.reason);
  }
}
