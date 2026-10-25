import { Account, RpcProvider, cairo, CallData } from "starknet";
import { SLAY_TOKEN, config } from "../config.ts";
import { normalizeAddress } from "../lib/format.ts";

const SLAY_DECIMALS = 18;

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

  try {
    const account = new Account({
      provider,
      address: normalizeAddress(config.slayTipAccountAddress),
      signer: config.slayTipPrivateKey,
    });
    const amount = cairo.uint256(BigInt(Math.round(prizeSlay * 10 ** SLAY_DECIMALS)));
    const calldata = CallData.compile({
      recipient: normalizeAddress(recipient),
      amount,
    });
    const result = await account.execute([
      {
        contractAddress: normalizeAddress(SLAY_TOKEN),
        entrypoint: "transfer",
        calldata,
      },
    ]);
    const hash = result.transaction_hash;
    await provider.waitForTransaction(hash);
    return { ok: true, txHash: hash };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("Wheel SLAY transfer failed:", error);
    return { ok: false, error: msg };
  }
}
