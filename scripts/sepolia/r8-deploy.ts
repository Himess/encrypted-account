/**
 * The current build on Sepolia, prepared and NOT run without the owner's approval: the four libraries (all changed since
 * F0.16), the standard implementation and its factory (the site's FACTORY), PrivateModule, EncryptedAccountP and its
 * factory (FACTORY_P), both implementations on the shared F0.16 FeeConfig, and the web constants afterwards.
 *
 *   npx hardhat compile
 *   RSTEP=check  npx hardhat run scripts/sepolia/r8-deploy.ts   → balance, gas price, an estimate per deployment (no transaction)
 *   RSTEP=deploy npx hardhat run scripts/sepolia/r8-deploy.ts   → the 9 deployments (resumable: results/sepolia/state-r8.json)
 *   RSTEP=web    npx hardhat run scripts/sepolia/r8-deploy.ts   → writes the new factories into web/src/chain.ts (the old ones
 *                                                                stay reachable through LEGACY_FACTORIES)
 *
 * Deployments do no FHE operation: they put no load on Zama's testnet. The key is read only from .env.sepolia and never
 * printed: addresses, hashes and gas only.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { Build, deployFromBuild, linkBytecode } from "../lib/deploy";
import { ROOT } from "../lib/env";
import { ENTRYPOINT_V08, eth, gwei, makeProvider, makeSigner, probeRpcs } from "../lib/net";

const STEP = process.env.RSTEP ?? "check";
const OUT = path.join(ROOT, "results", "sepolia");
const STATE = path.join(OUT, "state-r8.json");
const CHAIN_TS = path.join(ROOT, "web", "src", "chain.ts");
/** F0.16's FeeConfig (results/sepolia/state-f016.json), unchanged since: both new implementations read it. */
const FEE_CONFIG = "0xe555608B8768580DC28D4445cfE343b5eb1769c0";

/** Deployment order: a library before what links it, an implementation before its factory. */
const PLAN: { name: string; key: string; args: (c: Record<string, string>) => unknown[]; libs: (c: Record<string, string>) => Record<string, string> }[] = [
  { name: "PinLib", key: "PinLib", args: () => [], libs: () => ({}) },
  { name: "PolicyLib", key: "PolicyLib", args: () => [], libs: () => ({}) },
  { name: "OpenLib", key: "OpenLib", args: () => [], libs: () => ({}) },
  { name: "OpsLib", key: "OpsLib", args: () => [], libs: (c) => ({ PolicyLib: c.PolicyLib }) },
  { name: "EncryptedAccount", key: "EncryptedAccount", args: () => [ENTRYPOINT_V08, FEE_CONFIG], libs: (c) => libsOf(c) },
  { name: "EncryptedAccountFactory", key: "Factory", args: (c) => [c.EncryptedAccount], libs: () => ({}) },
  { name: "PrivateModule", key: "PrivateModule", args: () => [ENTRYPOINT_V08], libs: (c) => ({ OpenLib: c.OpenLib }) },
  { name: "EncryptedAccountP", key: "EncryptedAccountP", args: (c) => [ENTRYPOINT_V08, FEE_CONFIG, c.PrivateModule], libs: (c) => libsOf(c) },
  { name: "EncryptedAccountFactory", key: "FactoryP", args: (c) => [c.EncryptedAccountP], libs: () => ({}) },
];

const libsOf = (c: Record<string, string>) => ({ PinLib: c.PinLib, PolicyLib: c.PolicyLib, OpenLib: c.OpenLib, OpsLib: c.OpsLib });
type State = { contracts: Record<string, string>; blocks: Record<string, number>; gas: Record<string, string> };
const load = (): State => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { contracts: {}, blocks: {}, gas: {} });
const save = (s: State) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
};

async function build(): Promise<Build> {
  const contracts: Build["contracts"] = {};
  for (const n of new Set(PLAN.map((p) => p.name))) {
    const a = await hre.artifacts.readArtifact(n);
    contracts[n] = { abi: a.abi as any[], bytecode: a.bytecode, linkReferences: a.linkReferences, deployedBytecodeBytes: (a.deployedBytecode.length - 2) / 2 };
  }
  return { contracts };
}

async function main() {
  const provider = makeProvider();
  await probeRpcs(provider);
  const user = makeSigner(provider);
  const b = await build();
  const st = load();
  const fee = await provider.getFeeData();
  const price = fee.gasPrice ?? 0n;
  console.log(`burner ${user.address} · ${eth(await provider.getBalance(user.address))} ETH · gas price ≈ ${gwei(price).toFixed(4)} gwei`);

  if (STEP === "check") {
    // placeholders for the not-yet-deployed libraries: the bytecode has the same size, so the estimate holds
    const dummy = (k: string) => st.contracts[k] ?? ethers.getAddress("0x" + ethers.id(k).slice(26));
    const c = new Proxy({} as Record<string, string>, { get: (_t, k: string) => dummy(k) });
    let total = 0n;
    for (const p of PLAN) {
      if (st.contracts[p.key]) {
        console.log(`  ${p.key}: deployed at ${st.contracts[p.key]}`);
        continue;
      }
      const art = b.contracts[p.name];
      const f = new ethers.ContractFactory(art.abi, linkBytecode(art.bytecode, art.linkReferences, p.libs(c)), user);
      const tx = await f.getDeployTransaction(...p.args(c));
      const g = await provider.estimateGas({ ...tx, from: user.address });
      total += g;
      console.log(`  ${p.key}: ${art.deployedBytecodeBytes} B · ≈ ${g} gas`);
    }
    console.log(`total ≈ ${total} gas ≈ ${eth(total * price)} ETH at the current price (keep 2× for price swings)`);
    return;
  }

  if (STEP === "deploy") {
    for (const p of PLAN) {
      if (st.contracts[p.key] && (await provider.getCode(st.contracts[p.key])).length > 2) continue;
      const d = await deployFromBuild(user, b, p.name, p.args(st.contracts), p.libs(st.contracts));
      st.contracts[p.key] = d.address;
      st.blocks[p.key] = d.tx.blockNumber;
      st.gas[p.key] = String(d.tx.gasUsed);
      save(st);
      console.log(`  ${p.key} @ ${d.address} · ${d.runtimeBytes} B · gas ${d.tx.gasUsed} · ${d.tx.hash}`);
    }
    console.log(`done: ${STATE}`);
    return;
  }

  if (STEP === "web") {
    if (!st.contracts.Factory || !st.contracts.FactoryP) throw new Error("deploy first");
    let s = fs.readFileSync(CHAIN_TS, "utf8");
    const old = (re: RegExp) => (re.exec(s) ?? [])[1];
    const oldFactory = old(/export const FACTORY = "(0x[0-9a-fA-F]{40})";/);
    const oldFactoryP = old(/export const FACTORY_P = "(0x[0-9a-fA-F]{40})";/);
    const legacy = (old(/export const LEGACY_FACTORIES = \[([^\]]*)\];/) ?? "")
      .split(",")
      .map((x) => x.trim().replace(/"/g, ""))
      .filter(Boolean);
    const keep = [...new Set([...(oldFactory ? [oldFactory] : []), ...(oldFactoryP ? [oldFactoryP] : []), ...legacy])];
    s = s
      .replace(/export const FACTORY = "0x[0-9a-fA-F]{40}";/, `export const FACTORY = "${st.contracts.Factory}";`)
      .replace(/export const FACTORY_DEPLOY_BLOCK = [0-9_]+;/, `export const FACTORY_DEPLOY_BLOCK = ${st.blocks.Factory};`)
      .replace(/export const FACTORY_P = "(0x[0-9a-fA-F]{40})?";/, `export const FACTORY_P = "${st.contracts.FactoryP}";`)
      .replace(/export const FACTORY_P_DEPLOY_BLOCK = [0-9_]+;/, `export const FACTORY_P_DEPLOY_BLOCK = ${st.blocks.FactoryP};`)
      .replace(/export const LEGACY_FACTORIES = \[[^\]]*\];/, `export const LEGACY_FACTORIES = [${keep.map((a) => `"${a}"`).join(", ")}];`);
    fs.writeFileSync(CHAIN_TS, s);
    console.log(`web/src/chain.ts: FACTORY ${st.contracts.Factory}, FACTORY_P ${st.contracts.FactoryP}, legacy ${keep.length}`);
    return;
  }
  throw new Error(`unknown RSTEP ${STEP}`);
}

main().catch((e) => {
  console.error(String(e?.shortMessage ?? e?.message ?? e).slice(0, 400));
  process.exitCode = 1;
});
