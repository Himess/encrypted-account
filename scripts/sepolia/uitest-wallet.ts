/**
 * Test wallet for the web demo's end-to-end runs (web/serve.mjs --devwallet). Sepolia only.
 *   npx hardhat run scripts/sepolia/uitest-wallet.ts
 * - Generates a random key into .env.sepolia (SEPOLIA_UITEST_KEY) if there is none. The key is never printed.
 * - Tops it up from the burner to UITEST_FUND_ETH (default 0.004 ETH) if it holds less than half of that.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import { ENV_SEPOLIA, hasUiTestKey, readEnvSepolia, sepoliaUiTestKey } from "../lib/env";
import { makeProvider, makeSigner, probeRpcs } from "../lib/net";

async function main() {
  let env = readEnvSepolia();
  if (!hasUiTestKey(env)) {
    const w = ethers.Wallet.createRandom();
    const cur = fs.existsSync(ENV_SEPOLIA) ? fs.readFileSync(ENV_SEPOLIA, "utf8") : "";
    const block = [`# Web demo test wallet (web/serve.mjs --devwallet) — Sepolia only. Address: ${w.address}`, `SEPOLIA_UITEST_KEY=${w.privateKey}`, ""].join("\n");
    fs.writeFileSync(ENV_SEPOLIA, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + block, { mode: 0o600 });
    env = readEnvSepolia();
    console.log(`UI test wallet: ${w.address} (new; key only in .env.sepolia)`);
  }
  const address = new ethers.Wallet(sepoliaUiTestKey(env)).address;
  const provider = makeProvider();
  await probeRpcs(provider);
  const target = ethers.parseEther(process.env.UITEST_FUND_ETH ?? "0.004");
  const bal = await provider.getBalance(address);
  console.log(`UI test wallet: ${address} · balance ${ethers.formatEther(bal)} ETH`);
  if (bal >= target / 2n) return;
  const burner = makeSigner(provider);
  const tx = await burner.sendTransaction({ to: address, value: target - bal });
  console.log(`top-up from the burner: ${ethers.formatEther(target - bal)} ETH · ${tx.hash}`);
  await tx.wait(1);
  console.log(`balance now ${ethers.formatEther(await provider.getBalance(address))} ETH`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e).slice(0, 400));
  process.exit(1);
});
