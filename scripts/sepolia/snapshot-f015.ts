/**
 * F0.15 — a copy of the build with the slot-saving storage layout (the F0.9 / F0.10 / F0.11 copies are not touched).
 *   npx hardhat run scripts/sepolia/snapshot-f015.ts                → results/sepolia/f015/build.json
 *   SEP_RUN=f015b npx hardhat run scripts/sepolia/snapshot-f015.ts  → results/sepolia/f015b/build.json (epoch counters)
 * Source hashes are recorded; if the sources have changed, the copy is refreshed.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { ROOT } from "../lib/env";

const NAMES = ["PinLib", "PolicyLib", "OpenLib", "OpsLib", "EncryptedAccount", "EncryptedAccountB", "EncryptedAccountFactory"];
const RUN = process.env.SEP_RUN ?? "f015";
const EVIDENCE: Record<string, string> = {
  f015: "F0.15 build (per-track guess records, packed counters, op content hash recomputed, stored back-off)",
  f015b: "F0.15 build, step 2 (as f015; epoch counters restart at 1 instead of 0)",
};
if (!EVIDENCE[RUN]) throw new Error(`SEP_RUN must be one of ${Object.keys(EVIDENCE).join(", ")}`);

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
  const file = path.join(ROOT, "results", "sepolia", RUN, "build.json");
  const sources = sourceHashes();
  if (fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    if (JSON.stringify(prev.sources) === JSON.stringify(sources)) {
      console.log(`${RUN} copy is up to date (${prev.createdAtUtc}).`);
      return;
    }
    // a copy whose contracts are deployed must not be replaced: the deployed bytecode would no longer match it
    if (fs.existsSync(path.join(ROOT, "results", "sepolia", `setup-${RUN}.json`))) throw new Error(`${RUN} is already deployed; use a new run name`);
    console.log(`Sources changed: refreshing the ${RUN} copy.`);
  }
  const contracts: Record<string, any> = {};
  for (const n of NAMES) {
    const a = await hre.artifacts.readArtifact(n);
    contracts[n] = { sourceName: a.sourceName, abi: a.abi, bytecode: a.bytecode, linkReferences: a.linkReferences, deployedBytecodeBytes: (a.deployedBytecode.length - 2) / 2 };
  }
  const solc = (hre.config.solidity as any).compilers[0];
  const out = {
    evidence: EVIDENCE[RUN],
    createdAtUtc: new Date().toISOString(),
    solc: { version: solc.version, settings: solc.settings },
    sources,
    contracts,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  const digest = createHash("sha256").update(JSON.stringify(out.contracts)).digest("hex").slice(0, 16);
  console.log(`${RUN} copy written: ${NAMES.length} contracts, digest ${digest} → results/sepolia/${RUN}/build.json`);
  for (const n of NAMES) console.log(`  ${n.padEnd(24)} ${contracts[n].deployedBytecodeBytes} B`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
