/**
 * F0.8.3 — Reads the current Sepolia gas price, multiplies it by the Round 2 §3 plan and prints the recommended funding with a 30% margin.
 * Also runs preflight checks (read-only, sends no transactions): RPCs, code at EntryPoint v0.8 and the Zama host contracts,
 * relayer access (key download + one off-chain input proof). Output: results/sepolia/funding-estimate.json
 *
 *   npx hardhat run scripts/sepolia/estimate-funding.ts
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { ROOT, hasSepoliaKey, readEnvSepolia, sepoliaPrivateKey } from "../lib/env";
import { makeFhevmClient, sepoliaFhevmChain } from "../lib/fhevm";
import { ENTRYPOINT_V08, eth, gwei, makeProvider, probeRpcs } from "../lib/net";

// Round 2 document §3 — estimated gas plan (item, gas, basis)
const PLAN_S3: [string, number, string][] = [
  ["Deployment ×2 (baseline + after fixes)", 30e6, "20 KiB account + 4 libraries + factory + test contracts [I]"],
  ["Account setups (A ×3, B ×1)", 36e6, "A setup ≈ 10.7M [I, from mock parts]; B has no encrypted slots"],
  ["E1 PIN flow ×30", 71e6, "≈ 2.37M / flow [Mock total]"],
  ["K-only hot path (A) ×30", 46e6, "≈ 1.53M / flow [Mock total]"],
  ["Variant B ×30", 3e6, "Plain-transfer level [I]"],
  ["Live checks", 13e6, "isIn 60/61, τ draws, escape, AA [I]"],
];
const PLAN_TOTAL = 200e6; // rounded total from the document
const MARGIN = 1.3;

const ZAMA = {
  ACL: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
  FHEVMExecutor: "0x92C920834Ec8941d2C77D188936E1f7A6f49c127",
  KMSVerifier: "0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A",
};

/** Deployment gas estimate from bytecode: base + calldata + code storage (200 gas/byte) + initcode word cost + constructor allowance. */
function deployGasFromArtifact(name: string): { name: string; runtimeBytes: number; initBytes: number; gas: number } {
  const a = hre.artifacts.readArtifactSync(name);
  const init = ethers.getBytes(a.bytecode.replace(/__\$[0-9a-fA-F]{34}\$__/g, "11".repeat(20)));
  const runtime = (a.deployedBytecode.length - 2) / 2;
  let calldata = 0;
  for (const b of init) calldata += b === 0 ? 4 : 16;
  const gas = 21_000 + 32_000 + calldata + 200 * runtime + 2 * Math.ceil(init.length / 32) + 60_000;
  return { name, runtimeBytes: runtime, initBytes: init.length, gas };
}

async function main() {
  const env = readEnvSepolia();
  if (!hasSepoliaKey(env)) throw new Error(".env.sepolia is missing or contains no key. First run: npx hardhat run scripts/burner.ts");
  const address = new ethers.Wallet(sepoliaPrivateKey(env)).address;
  const provider = makeProvider();

  console.log(`\nBurner address: ${address}\n`);
  console.log("── RPC preflight");
  const rpc = await probeRpcs(provider);
  for (const r of rpc.rows) console.log(`  ${r.ok ? "✓" : "✗"} ${r.url}${r.ok ? `  block ${r.block}, ${r.ms} ms` : `  ${r.error}`}`);
  if (!rpc.best) throw new Error("No working Sepolia RPC found.");

  const [block, balance, gasPriceHex, tipHex, hist] = await Promise.all([
    provider.getBlock("latest"),
    provider.getBalance(address),
    provider.send("eth_gasPrice", []),
    provider.send("eth_maxPriorityFeePerGas", []).catch(() => null),
    provider.send("eth_feeHistory", ["0x64", "latest", [10, 50, 90]]).catch(() => null),
  ]);
  const baseNow = block?.baseFeePerGas ?? 0n;
  const baseFees: bigint[] = hist ? hist.baseFeePerGas.map((x: string) => BigInt(x)) : [baseNow];
  const baseMax = baseFees.reduce((a, b) => (b > a ? b : a), 0n);
  const baseMedian = [...baseFees].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(baseFees.length / 2)];
  const p50Rewards: bigint[] = hist?.reward ? hist.reward.map((r: string[]) => BigInt(r[1])) : [];
  const rewardMedian = p50Rewards.length ? [...p50Rewards].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(p50Rewards.length / 2)] : 0n;
  const fee = await provider.getFeeData(); // the fee the scripts will use (base + capped priority)
  const tipUsed = fee.maxPriorityFeePerGas!;
  const priceNow = baseNow + tipUsed; // unit price paid at inclusion ≈ base + priority
  const priceSafe = baseMax + tipUsed; // with the highest base fee of the last 100 blocks
  const gasPrice = BigInt(gasPriceHex);

  console.log("\n── Sepolia gas price");
  console.log(`  block ${block?.number}  base fee ${gwei(baseNow).toFixed(4)} gwei  (last 100 blocks: median ${gwei(baseMedian).toFixed(4)}, highest ${gwei(baseMax).toFixed(4)})`);
  console.log(`  eth_gasPrice ${gwei(gasPrice).toFixed(4)} gwei  node priority suggestion ${tipHex ? gwei(BigInt(tipHex)).toFixed(4) : "?"} gwei  block p50 reward ${gwei(rewardMedian).toFixed(4)} gwei`);
  console.log(`  priority fee the scripts will use ${gwei(tipUsed).toFixed(4)} gwei → unit price ≈ ${gwei(priceNow).toFixed(4)} gwei`);

  console.log("\n── Preflight checks (read-only)");
  const code = async (a: string) => (await provider.getCode(a)).length > 2;
  const chain = sepoliaFhevmChain();
  const checks: Record<string, any> = {
    entryPointV08: { address: ENTRYPOINT_V08, hasCode: await code(ENTRYPOINT_V08) },
    acl: { address: ZAMA.ACL, hasCode: await code(ZAMA.ACL) },
    fhevmExecutor: { address: ZAMA.FHEVMExecutor, hasCode: await code(ZAMA.FHEVMExecutor) },
    kmsVerifier: { address: ZAMA.KMSVerifier, hasCode: await code(ZAMA.KMSVerifier) },
    inputVerifier: { address: chain.fhevm.contracts.inputVerifier.address, hasCode: await code(chain.fhevm.contracts.inputVerifier.address) },
    protocolConfig: { address: chain.fhevm.contracts.protocolConfig.address, hasCode: await code(chain.fhevm.contracts.protocolConfig.address) },
    relayerUrl: chain.fhevm.relayerUrl,
  };
  for (const [k, v] of Object.entries(checks)) if (typeof v === "object") console.log(`  ${v.hasCode ? "✓" : "✗"} ${k} ${v.address}`);
  try {
    const t0 = performance.now();
    const client = await makeFhevmClient(provider);
    const tReady = performance.now();
    const enc = await client.encryptValues({ values: [{ type: "euint64", value: 1n }], contractAddress: ENTRYPOINT_V08, userAddress: address });
    const tProof = performance.now();
    checks.relayer = { ok: true, clientReadyMs: Math.round(tReady - t0), inputProofMs: Math.round(tProof - tReady), proofBytes: (enc.inputProof.length - 2) / 2 };
    console.log(`  ✓ relayer ${chain.fhevm.relayerUrl}: client ready ${checks.relayer.clientReadyMs} ms, off-chain input proof ${checks.relayer.inputProofMs} ms`);
  } catch (e: any) {
    checks.relayer = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
    console.log(`  ✗ relayer: ${checks.relayer.error}`);
  }

  // Cross-check: deployment gas from bytecode
  const deployNames = ["PinLib", "PolicyLib", "OpsLib", "OpenLib", "EncryptedAccount", "EncryptedAccountFactory", "Bench", "NaivePinVerifier", "TestPaymaster", "MockERC20"];
  const deploys = deployNames.map(deployGasFromArtifact);
  const oneDeploy = deploys.reduce((s, d) => s + d.gas, 0);

  const totalGas = BigInt(PLAN_TOTAL);
  const extraWei = ethers.parseEther("0.005"); // value transfers + paymaster deposit (mostly recovered)
  const rec = (price: bigint) => (totalGas * price * BigInt(Math.round(MARGIN * 100))) / 100n + extraWei;
  const scen = [
    { label: "current price", price: priceNow },
    { label: "max base fee of last 100 blocks", price: priceSafe },
    { label: "1 gwei", price: ethers.parseUnits("1", "gwei") },
    { label: "5 gwei", price: ethers.parseUnits("5", "gwei") },
    { label: "10 gwei", price: ethers.parseUnits("10", "gwei") },
  ].map((s) => ({ ...s, recommendedWei: rec(s.price) }));
  const formulaWei = scen[1].recommendedWei > scen[0].recommendedWei ? scen[1].recommendedWei : scen[0].recommendedWei;
  // Practical recommendation: 3× the formula (Sepolia fees can swing several-fold), at least 0.05 ETH, rounded up to 0.01.
  const step = ethers.parseEther("0.01");
  let recommendedWei = formulaWei * 3n > ethers.parseEther("0.05") ? formulaWei * 3n : ethers.parseEther("0.05");
  recommendedWei = ((recommendedWei + step - 1n) / step) * step;
  // Starting threshold: smoke test + baseline deployment + one A setup
  const minStartGas = BigInt(oneDeploy) + 12_000_000n + 2_000_000n;
  const minStartWei = (minStartGas * (2n * baseMax + tipUsed) * 13n) / 10n;

  console.log("\n── §3 plan");
  for (const [k, g, why] of PLAN_S3) console.log(`  ${(g / 1e6).toFixed(0).padStart(4)}M  ${k}  (${why})`);
  console.log(`  ${(PLAN_TOTAL / 1e6).toFixed(0).padStart(4)}M  TOTAL`);
  console.log(`  Cross-check: one full deployment from bytecode ≈ ${(oneDeploy / 1e6).toFixed(1)}M gas (×2 = ${((2 * oneDeploy) / 1e6).toFixed(1)}M; plan 30M).`);

  console.log("\n── Recommended funding = 200M gas × unit price × 1.3 + 0.005 ETH (value transfers/paymaster)");
  for (const s of scen) console.log(`  ${s.label.padEnd(34)} ${gwei(s.price).toFixed(4).padStart(9)} gwei → ${Number(eth(s.recommendedWei)).toFixed(4)} ETH`);
  console.log(`\n  Current balance: ${eth(balance)} ETH`);
  console.log(`\n>>> RECOMMENDED FUNDING: ${Number(eth(recommendedWei)).toFixed(2)} Sepolia ETH → ${address}`);
  console.log(`    Formula (at the current price): ${Number(eth(formulaWei)).toFixed(4)} ETH; the recommendation includes a 3× margin against fee swings.`);
  console.log(`    At least ≈ ${Number(eth(minStartWei)).toFixed(4)} ETH is enough to start; if the balance runs out, the scripts print the shortfall and resume where they left off after funding.\n`);

  const out = {
    evidence: "[M] Sepolia read; plan [I] (Round 2 §3)",
    generatedAtUtc: new Date().toISOString(),
    address,
    balanceWei: balance.toString(),
    rpc,
    gas: {
      block: block?.number,
      baseFeeGwei: gwei(baseNow),
      baseFee100: { medianGwei: gwei(baseMedian), maxGwei: gwei(baseMax) },
      ethGasPriceGwei: gwei(gasPrice),
      nodePriorityGwei: tipHex ? gwei(BigInt(tipHex)) : null,
      blockP50RewardGwei: gwei(rewardMedian),
      tipUsedGwei: gwei(tipUsed),
      unitPriceNowGwei: gwei(priceNow),
      unitPriceSafeGwei: gwei(priceSafe),
    },
    planS3: PLAN_S3.map(([item, gas, basis]) => ({ item, gas, basis })),
    planTotalGas: PLAN_TOTAL,
    margin: MARGIN,
    extraWei: extraWei.toString(),
    scenarios: scen.map((s) => ({ label: s.label, priceGwei: gwei(s.price), recommendedEth: eth(s.recommendedWei) })),
    formulaEth: eth(formulaWei),
    recommendedEth: eth(recommendedWei),
    recommendationRule: "max(3 × formula, 0.05 ETH), rounded up to 0.01 ETH",
    minStartEth: eth(minStartWei),
    deployCrossCheck: { contracts: deploys, oneFullDeployGas: oneDeploy },
    preflight: checks,
  };
  const dir = path.join(ROOT, "results", "sepolia");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "funding-estimate.json"), JSON.stringify(out, null, 2));
  console.log("→ results/sepolia/funding-estimate.json");
  provider.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
