/**
 * HCU of a live transaction: Zama's price table is applied to the FHEVMExecutor's operation events (same code as the
 * Hardhat plugin's `computeTransactionHCU`). It is not a meter read from the chain but a cost model computed from events;
 * evidence class "[M] computed from events".
 */
import type { ethers } from "ethers";
import { ethers as E } from "ethers";
import * as path from "path";
import { ROOT } from "./env";

export const SEPOLIA_EXECUTOR = "0x92C920834Ec8941d2C77D188936E1f7A6f49c127";

let cached: { fn: any; itf: ethers.Interface } | undefined;

function load() {
  if (cached) return cached;
  // The plugin's `exports` field hides its internal modules; load it by file path (read-only).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join(ROOT, "node_modules", "@fhevm", "hardhat-plugin", "_cjs", "internal", "hcu", "hcu.js"));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const abi = require(path.join(ROOT, "node_modules", "@fhevm", "host-contracts-cleartext", "abi", "CleartextFHEVMExecutor.json"));
  cached = { fn: mod.getTxHCUFromTxReceipt, itf: new E.Interface(Array.isArray(abi) ? abi : abi.abi) };
  return cached;
}

/**
 * Return value of the plugin's `getTxHCUFromTxReceipt`: { globalHCU, maxHCUDepth, HCUDepthByHandle } (hcu.js).
 * (The previous version read field names that do not exist and always returned 0; fixed in F0.9.)
 * `receipt` can also be given with only the { status, hash, logs } fields (for cross-checking against the logs of
 * other transactions in the block).
 */
export function txHCU(
  receipt: Pick<ethers.TransactionReceipt, "status" | "hash" | "logs">,
  executor = SEPOLIA_EXECUTOR,
): { total: number; depth: number; ops: number } | null {
  try {
    const { fn, itf } = load();
    const info = fn(executor, itf, receipt);
    let ops = 0;
    for (const l of receipt.logs) if (l.address.toLowerCase() === executor.toLowerCase()) ops++;
    return { total: Number(info.globalHCU ?? 0), depth: Number(info.maxHCUDepth ?? 0), ops };
  } catch {
    return null;
  }
}
