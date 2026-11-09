// Reads the live Zama host contracts (eth_call / eth_getStorageAt only; sends no transactions).
// Run: node scripts/probe-live-zama.mjs  → results/live-chain-probe.json
import { ethers } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";

const nets = {
  sepolia: {
    rpc: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    acl: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
    exec: "0x92C920834Ec8941d2C77D188936E1f7A6f49c127",
    kms: "0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A",
  },
  mainnet: {
    rpc: process.env.MAINNET_RPC || "https://ethereum-rpc.publicnode.com",
    acl: "0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6",
    exec: "0xD82385dADa1ae3E969447f20A3164F6213100e75",
    kms: "0x77627828a55156b04Ac0DC0eb30467f1a552BB03",
  },
};
const abi = [
  "function getVersion() view returns (string)",
  "function getHCULimitAddress() view returns (address)",
  "function getThreshold() view returns (uint256)",
  "function getKmsSigners() view returns (address[])",
  "function owner() view returns (address)",
];
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967
const HCU_SLOT = "0xc13af6c514bff8997f30c90003baa82bd02aad978179d1ce58d85c4319ad6500"; // ERC-7201 fhevm.storage.HCULimit
const sel = (sig) => ethers.id(sig).slice(2, 10);
const SELECTORS = ["fheIsIn(bytes32,bytes32[],uint8)", "fheSum(bytes32[],uint8)", "checkHandleType(bytes32,uint8)", "fheRandBounded(uint256,uint8)"];

const report = { evidence: "[M] live chain read", date: new Date().toISOString(), networks: {} };

for (const [name, n] of Object.entries(nets)) {
  const p = new ethers.JsonRpcProvider(n.rpc);
  const block = await p.getBlockNumber();
  const net = (report.networks[name] = { block, contracts: {} });
  console.log(`\n=== ${name} block ${block}`);
  for (const [label, addr] of [["ACL", n.acl], ["FHEVMExecutor", n.exec], ["KMSVerifier", n.kms]]) {
    const c = new ethers.Contract(addr, abi, p);
    let v;
    try {
      v = await c.getVersion();
    } catch (e) {
      v = "ERR " + e.shortMessage;
    }
    const impl = ethers.getAddress("0x" + (await p.getStorage(addr, IMPL_SLOT)).slice(26));
    const entry = (net.contracts[label] = { proxy: addr, implementation: impl, version: v });
    console.log(`${label.padEnd(14)} ${addr} -> impl ${impl} :: ${v}`);
    if (label === "ACL") {
      try {
        entry.owner = await c.owner();
      } catch {
        /* n/a */
      }
    }
    if (label === "FHEVMExecutor") {
      const code = await p.getCode(impl);
      entry.selectors = {};
      for (const s of SELECTORS) entry.selectors[s] = code.includes(sel(s));
      console.log("   selectors", JSON.stringify(entry.selectors));
      const hcu = await c.getHCULimitAddress();
      const hv = await new ethers.Contract(hcu, abi, p).getVersion();
      const raw = BigInt(await p.getStorage(hcu, HCU_SLOT));
      const m = (1n << 48n) - 1n;
      net.hcuLimit = {
        address: hcu,
        version: hv,
        capPerBlock: String(raw & m),
        maxHCUDepthPerTx: String((raw >> 144n) & m),
        maxHCUPerTx: String((raw >> 192n) & m),
      };
      console.log("   HCULimit", JSON.stringify(net.hcuLimit));
    }
    if (label === "KMSVerifier") {
      entry.kmsSignatureThreshold = (await c.getThreshold()).toString();
      entry.kmsSigners = (await c.getKmsSigners()).length;
      console.log(`   KMS signature threshold ${entry.kmsSignatureThreshold} of ${entry.kmsSigners}`);
    }
  }
}
mkdirSync("results", { recursive: true });
writeFileSync("results/live-chain-probe.json", JSON.stringify(report, null, 2));
console.log("\n-> results/live-chain-probe.json");
