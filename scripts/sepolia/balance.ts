/** Burner address, balance and current fee (read-only).  npx hardhat run scripts/sepolia/balance.ts */
import { ethers } from "ethers";
import { readEnvSepolia, sepoliaPrivateKey } from "../lib/env";
import { eth, gwei, makeProvider } from "../lib/net";

async function main() {
  const address = new ethers.Wallet(sepoliaPrivateKey(readEnvSepolia())).address;
  const p = makeProvider();
  const [bal, fee, bn, nonce] = await Promise.all([p.getBalance(address), p.getFeeData(), p.getBlockNumber(), p.getTransactionCount(address, "latest")]);
  console.log(`address ${address}`);
  console.log(`balance ${eth(bal)} ETH · nonce ${nonce} · block ${bn}`);
  console.log(`fee: base+priority ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei (priority ${gwei(fee.maxPriorityFeePerGas!).toFixed(4)}, cap ${gwei(fee.maxFeePerGas!).toFixed(4)})`);
  p.destroy();
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
