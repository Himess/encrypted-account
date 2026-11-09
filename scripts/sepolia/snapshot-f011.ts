/**
 * F0.11 — a copy of the build with the B variant (A and B with the same libraries; the F0.9 / F0.10 copies are not touched).
 *   npx hardhat run scripts/sepolia/snapshot-f011.ts      → results/sepolia/f011/build.json
 * Source hashes are recorded; if the sources have changed, the copy is refreshed.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { ROOT } from "../lib/env";

const NAMES = ["PinLib", "PolicyLib", "OpenLib", "OpsLib", "EncryptedAccount", "EncryptedAccountB", "EncryptedAccountFactory"];

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
  const file = path.join(ROOT, "results", "sepolia", "f011", "build.json");
  const sources = sourceHashes();
  if (fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    if (JSON.stringify(prev.sources) === JSON.stringify(sources)) {
      console.log(`F0.11 copy is up to date (${prev.createdAtUtc}).`);
      return;
    }
    console.log("Sources changed: refreshing the F0.11 copy.");
  }
  const contracts: Record<string, any> = {};
  for (const n of NAMES) {
    const a = await hre.artifacts.readArtifact(n);
    contracts[n] = { sourceName: a.sourceName, abi: a.abi, bytecode: a.bytecode, linkReferences: a.linkReferences, deployedBytecodeBytes: (a.deployedBytecode.length - 2) / 2 };
  }
  const solc = (hre.config.solidity as any).compilers[0];
  const out = {
    evidence: "F0.11 build (variant B: open list, open limit, synchronous K-only; A unchanged alongside)",
    createdAtUtc: new Date().toISOString(),
    solc: { version: solc.version, settings: solc.settings },
    sources,
    contracts,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  const digest = createHash("sha256").update(JSON.stringify(out.contracts)).digest("hex").slice(0, 16);
  console.log(`F0.11 copy written: ${NAMES.length} contracts, digest ${digest} → results/sepolia/f011/build.json`);
  for (const n of NAMES) console.log(`  ${n.padEnd(24)} ${contracts[n].deployedBytecodeBytes} B`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
