/**
 * Status (read-only): burner and watchtower addresses, balances, nonces and the current fee.
 * Keys are never printed.   npx hardhat run scripts/sepolia/status.ts
 */
import { ethers } from "ethers";
import { hasWatchtowerKey, readEnvSepolia, sepoliaPrivateKey, sepoliaWatchtowerKey } from "../lib/env";
import { eth, gwei, makeProvider } from "../lib/net";

async function main() {
  const env = readEnvSepolia();
  const user = new ethers.Wallet(sepoliaPrivateKey(env)).address;
  const wt = hasWatchtowerKey(env) ? new ethers.Wallet(sepoliaWatchtowerKey(env)).address : null;
  const p = makeProvider();
  const [bn, fee] = await Promise.all([p.getBlockNumber(), p.getFeeData()]);
  const row = async (label: string, a: string) => {
    const [bal, nonce, pending] = await Promise.all([p.getBalance(a), p.getTransactionCount(a, "latest"), p.getTransactionCount(a, "pending")]);
    console.log(`${label.padEnd(9)} ${a}  balance ${eth(bal)} ETH  nonce ${nonce}${pending !== nonce ? ` (pending ${pending - nonce})` : ""}`);
  };
  console.log(`block ${bn} · fee ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei (priority ${gwei(fee.maxPriorityFeePerGas!).toFixed(4)})`);
  await row("burner", user);
  if (wt) await row("watchtower", wt);
  else console.log("watchtower (no key)");
  p.destroy();
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
