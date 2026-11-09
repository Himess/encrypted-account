// F0.9 side measurement — Sepolia's current gas schedule (read-only; no transactions sent, no key needed).
// Via eth_estimateGas: (1) code deposit cost / byte, (2) cost of a new storage slot (SSTORE 0→1),
// (3) sending ETH to a new account, (4) fields of the latest block header (which fork is active).
//   node scripts/sepolia/probe-gas.mjs [sender-address]   → results/sepolia/gas-schedule.json
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// --mainnet: the same queries on Ethereum mainnet (read-only; value transfers are not measured, no sender balance needed)
const MAINNET = process.argv.includes("--mainnet");
const CHAIN = MAINNET ? 1 : 11155111;
const RPCS = MAINNET
  ? ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"]
  : ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co", "https://1rpc.io/sepolia"];
const FROM = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) ?? (MAINNET ? "0x000000000000000000000000000000000000dEaD" : "0xcBdaED7D91644c771Aa84C5AbE5afFBB42a4d502");

const hex = (n, bytes) => n.toString(16).padStart(bytes * 2, "0");
// initcode: [SSTORE(i, 1) k times] + RETURN(0, size)  → the runtime code is `size` zero bytes
function initcode(size, sstores) {
  let c = "";
  for (let i = 0; i < sstores; i++) c += "6001" + "61" + hex(i, 2) + "55"; // PUSH1 1, PUSH2 i, SSTORE
  c += "61" + hex(size, 2) + "6000" + "f3"; // PUSH2 size, PUSH1 0, RETURN
  return "0x" + c;
}

async function main() {
  let provider;
  for (const u of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(u, CHAIN, { staticNetwork: ethers.Network.from(CHAIN) });
      await p.getBlockNumber();
      provider = p;
      break;
    } catch {
      /* next */
    }
  }
  if (!provider) throw new Error("no RPC");
  const est = async (tx) => Number(await provider.estimateGas({ from: FROM, ...tx }));

  const sizes = [0, 1024, 4096, 16384];
  const deploy = {};
  for (const s of sizes) deploy[s] = await est({ data: initcode(s, 0) });
  const perByte = (deploy[16384] - deploy[0]) / 16384;
  const perByte1k = (deploy[1024] - deploy[0]) / 1024;

  const ss = {};
  for (const k of [0, 1, 10]) ss[k] = await est({ data: initcode(0, k) });
  const perSlot = (ss[10] - ss[0]) / 10;

  const fresh = ethers.Wallet.createRandom().address;
  const ethToFresh = MAINNET ? null : await est({ to: fresh, value: 1n });
  const ethToSelf = MAINNET ? null : await est({ to: FROM, value: 1n });
  // an existing EOA other than the sender (the watchtower wallet; it has a balance on Sepolia)
  const OTHER = "0x8e98d5e45822b81Ac7dB853480c405E8Ea769B7A";
  const ethToOther = MAINNET ? null : await est({ to: OTHER, value: 1n });

  const raw = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const headerFields = Object.keys(raw).sort();
  const out = {
    evidence: `[M] ${MAINNET ? "Ethereum mainnet" : "Sepolia"} eth_estimateGas (no transaction sent)`,
    chainId: CHAIN,
    atUtc: new Date().toISOString(),
    block: Number(raw.number),
    gasLimit: Number(raw.gasLimit),
    baseFeeGwei: Number(BigInt(raw.baseFeePerGas)) / 1e9,
    headerFields,
    newHeaderFields: headerFields.filter(
      (f) =>
        ![
          "baseFeePerGas", "blobGasUsed", "difficulty", "excessBlobGas", "extraData", "gasLimit", "gasUsed", "hash", "logsBloom",
          "miner", "mixHash", "nonce", "number", "parentBeaconBlockRoot", "parentHash", "receiptsRoot", "requestsHash",
          "sha3Uncles", "size", "stateRoot", "timestamp", "totalDifficulty", "transactions", "transactionsRoot", "uncles",
          "withdrawals", "withdrawalsRoot",
        ].includes(f),
    ),
    createGasBySize: deploy,
    codeDepositPerByte: Math.round(perByte),
    codeDepositPerByte1k: Math.round(perByte1k),
    createGasBySstoreCount: ss,
    newSlotSstoreGas: Math.round(perSlot),
    ethTransferToFreshAddress: ethToFresh,
    ethTransferToSelf: ethToSelf,
    ethTransferToExisting: ethToOther,
    newAccountSurcharge: ethToFresh === null ? null : ethToFresh - ethToOther,
    reference: "Pre-Prague/Osaka values: code deposit 200 gas/byte; SSTORE 0→1 ≈ 22 100 (cold); value transfer to a new account +25 000.",
  };
  fs.mkdirSync(path.join(ROOT, "results", "sepolia"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "results", "sepolia", MAINNET ? "gas-schedule-mainnet.json" : "gas-schedule.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
