/**
 * F0.9 preliminary step — an immutable copy of the Round 1 build (the baseline). F0.9 runs "without code changes, with
 * the existing version"; even if F0.10/F0.11 change the contracts, the Sepolia measurement is deployed from this copy.
 *
 *   npx hardhat run scripts/sepolia/snapshot-baseline.ts      → results/sepolia/baseline/build.json
 *
 * If the copy already exists and the source hashes differ, it is NOT TOUCHED (the baseline is taken once); BASELINE_FORCE=1 refreshes it.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { ROOT } from "../lib/env";

const NAMES = [
  "PinLib",
  "PolicyLib",
  "OpenLib",
  "OpsLib",
  "EncryptedAccount",
  "EncryptedAccountFactory",
  "TestPaymaster",
  "ToolchainSpike",
  "Bench",
];

function sourceHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".sol")) out[path.relative(ROOT, p).replace(/\\/g, "/")] = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(path.join(ROOT, "contracts"));
  return out;
}

async function main() {
  await hre.run("compile");
  const file = path.join(ROOT, "results", "sepolia", "baseline", "build.json");
  const sources = sourceHashes();
  if (fs.existsSync(file) && process.env.BASELINE_FORCE !== "1") {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    const same = JSON.stringify(prev.sources) === JSON.stringify(sources);
    console.log(`Baseline copy already exists (${prev.createdAtUtc}); sources ${same ? "unchanged" : "CHANGED — keeping the baseline"}.`);
    return;
  }
  const contracts: Record<string, any> = {};
  for (const n of NAMES) {
    const a = await hre.artifacts.readArtifact(n);
    contracts[n] = {
      sourceName: a.sourceName,
      abi: a.abi,
      bytecode: a.bytecode,
      linkReferences: a.linkReferences,
      deployedBytecodeBytes: (a.deployedBytecode.length - 2) / 2,
    };
  }
  const solc = (hre.config.solidity as any).compilers[0];
  const out = {
    evidence: "Round 1 build (F0.9 baseline)",
    createdAtUtc: new Date().toISOString(),
    solc: { version: solc.version, settings: solc.settings },
    sources,
    contracts,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  const digest = createHash("sha256").update(JSON.stringify(out.contracts)).digest("hex").slice(0, 16);
  console.log(`Baseline copy written: ${NAMES.length} contracts, digest ${digest} → results/sepolia/baseline/build.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
