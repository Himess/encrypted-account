/**
 * F0.8.4 — Waits for the burner address to be funded (read-only). Exit conditions:
 *   - balance ≥ target (default: the recommendation in funding-estimate.json), or
 *   - balance ≥ starting threshold and unchanged for 10 minutes (partial funding complete), or
 *   - WAIT_MAX_HOURS (default 12) elapsed → exit code 4.
 *
 *   npx hardhat run scripts/sepolia/wait-funding.ts
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { ROOT, readEnvSepolia, sepoliaPrivateKey } from "../lib/env";
import { eth, makeProvider, sleep } from "../lib/net";

async function main() {
  const address = new ethers.Wallet(sepoliaPrivateKey(readEnvSepolia())).address;
  const est = JSON.parse(fs.readFileSync(path.join(ROOT, "results", "sepolia", "funding-estimate.json"), "utf8"));
  const target = ethers.parseEther(process.env.WAIT_TARGET_ETH ?? est.recommendedEth);
  const minStart = ethers.parseEther(est.minStartEth);
  const maxMs = Number(process.env.WAIT_MAX_HOURS ?? 12) * 3600_000;
  const provider = makeProvider({ pollingInterval: 4000 });
  const t0 = Date.now();
  let last = -1n;
  let lastChange = Date.now();
  console.log(`Waiting: ${address} (target ${eth(target)} ETH, starting threshold ${eth(minStart)} ETH)`);
  for (;;) {
    let bal: bigint;
    try {
      bal = await provider.getBalance(address);
    } catch {
      await sleep(20_000);
      continue;
    }
    if (bal !== last) {
      console.log(`${new Date().toISOString()} balance ${eth(bal)} ETH`);
      last = bal;
      lastChange = Date.now();
    }
    if (bal >= target) {
      console.log(`FUNDED: ${eth(bal)} ETH ≥ target`);
      process.exit(0);
    }
    if (bal >= minStart && Date.now() - lastChange > 10 * 60_000) {
      console.log(`PARTIAL FUNDING: ${eth(bal)} ETH (unchanged for 10 min; starting threshold exceeded)`);
      process.exit(0);
    }
    if (Date.now() - t0 > maxMs) {
      console.log(`Time limit reached; balance ${eth(bal)} ETH`);
      process.exit(4);
    }
    await sleep(20_000);
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
