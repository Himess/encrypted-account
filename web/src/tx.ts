/**
 * Sending transactions: our own gas estimate on the public RPC (+25%), a low explicit fee (Sepolia is nearly free,
 * and a wallet's default tip would make the 8-step setup cost far more than it needs to), and waiting for the
 * receipt on the public RPC. Reverts are decoded with the account's and libraries' custom errors.
 */
import { ethers } from "ethers";
import { ERRORS_ABI } from "./abi";
import type { Wallet } from "./wallet";

const ERR_IFACE = new ethers.Interface(ERRORS_ABI as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plain-language hints for the errors a visitor can actually run into. */
const HINTS: Record<string, string> = {
  NotReady: "Too early: this step has a waiting period.",
  Backoff: "Too early: wrong PINs add a growing wait before the next attempt.",
  StaleChallenge: "The challenge changed; start the transfer again.",
  SlotBusy: "A previous PIN check is still waiting to be finalized.",
  InputReplayed: "This encrypted input was already used.",
  NotAuthorized: "This wallet is not the owner of the account.",
  AlreadyArmed: "The account is already set up.",
  SetupIncomplete: "Setup is not finished yet.",
  EscapeActive: "An escape is running; transfers are closed.",
  TransferFailed: "The transfer failed (does the account hold enough ETH?).",
};

function revertData(e: any): string | null {
  const cands = [e?.data, e?.error?.data, e?.info?.error?.data, e?.error?.error?.data, e?.revert?.data];
  for (const c of cands) {
    if (typeof c === "string" && /^0x[0-9a-fA-F]{8,}$/.test(c)) return c;
    if (c && typeof c === "object" && typeof c.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(c.data)) return c.data;
  }
  const m = String(e?.message ?? "").match(/data="(0x[0-9a-fA-F]{8,})"/);
  return m ? m[1] : null;
}

export function explainError(e: any): string {
  const msg = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  if (e?.code === 4001 || e?.code === "ACTION_REJECTED" || /user (rejected|denied)/i.test(msg)) return "You rejected the request in your wallet.";
  const data = revertData(e);
  if (data) {
    try {
      const d = ERR_IFACE.parseError(data);
      if (d) return HINTS[d.name] ? `${HINTS[d.name]} (${d.name})` : `The contract refused: ${d.name}`;
    } catch {
      /* not one of ours */
    }
  }
  if (/insufficient funds/i.test(msg)) return "Your wallet does not have enough Sepolia ETH for gas.";
  return msg.slice(0, 300);
}

export type Status = (text: string, hash?: string) => void;

export async function sendTx(w: Wallet, read: ethers.JsonRpcProvider, req: ethers.TransactionRequest, status: Status): Promise<ethers.TransactionReceipt> {
  status("Preparing…");
  const [block, tipHex] = await Promise.all([read.getBlock("latest"), read.send("eth_maxPriorityFeePerGas", []).catch(() => "0x0")]);
  const base = block?.baseFeePerGas ?? 1_000_000n;
  let tip = BigInt(tipHex) * 2n;
  if (tip < 1_000_000n) tip = 1_000_000n; // ≥ 0.001 gwei
  const maxFeePerGas = base * 3n + tip;

  // A load-balanced public RPC can lag one block behind the previous receipt: retry the estimate a few times.
  let gas = 0n;
  let lastErr: any = null;
  for (let i = 0; i < 4 && gas === 0n; i++) {
    try {
      gas = await read.estimateGas({ ...req, from: w.address });
    } catch (e) {
      lastErr = e;
      await sleep(2500);
    }
  }
  if (gas === 0n) throw new Error(explainError(lastErr));

  status("Confirm in your wallet…");
  let resp: ethers.TransactionResponse;
  try {
    resp = await w.signer.sendTransaction({ ...req, gasLimit: (gas * 125n) / 100n, maxFeePerGas, maxPriorityFeePerGas: tip, type: 2 });
  } catch (e) {
    throw new Error(explainError(e));
  }
  status("Waiting for the block…", resp.hash);
  const receipt = await read.waitForTransaction(resp.hash, 1, 600_000);
  if (!receipt) throw new Error("Timed out waiting for the transaction.");
  if (receipt.status !== 1) throw new Error(`The transaction reverted (${resp.hash.slice(0, 10)}…).`);
  for (let i = 0; i < 20 && (await read.getBlockNumber()) < receipt.blockNumber; i++) await sleep(1000);
  return receipt;
}
