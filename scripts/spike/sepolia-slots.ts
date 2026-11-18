/**
 * SPIKE (private mode) — new storage slots per Sepolia transaction of the spike run, read from the block access list
 * (EIP-7928, eth_getBlockAccessList), and the "today's mainnet equivalent" gas: Sepolia prices a new slot at 110,983 gas,
 * mainnet at 22,445 (results/sepolia/gas-schedule*.json). Same method as scripts/sepolia/f015-slots.ts.
 *
 *   npx hardhat run --no-compile scripts/spike/sepolia-slots.ts
 * Input: results/spike/sepolia/state.json. Output: results/spike/sepolia/slots.json.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { ROOT } from "../lib/env";
import { makeProvider } from "../lib/net";

const DIR = path.join(ROOT, "results", "spike", "sepolia");
const sched = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "results", "sepolia", f), "utf8"));

async function newSlots(provider: any, hash: string): Promise<{ gasUsed: number; newSlots: number; newAccounts: number }> {
  const rc = await provider.getTransactionReceipt(hash);
  const idx = rc.index + 1; // BAL index: 0 = pre-block system calls, i + 1 = transaction i
  const bn = rc.blockNumber;
  const bal: any[] = await provider.send("eth_getBlockAccessList", [ethers.toQuantity(bn)]);
  let n = 0;
  let accounts = 0;
  for (const e of bal) {
    const mine = (e.storageChanges ?? []).filter((sc: any) => sc.changes.some((c: any) => Number(c.index) === idx));
    for (const sc of mine) {
      const earlier = sc.changes.filter((c: any) => Number(c.index) < idx).sort((a: any, b: any) => Number(b.index) - Number(a.index))[0];
      const pre = earlier ? BigInt(earlier.value) : BigInt(await provider.getStorage(e.address, sc.key, bn - 1));
      const post = BigInt(sc.changes.find((c: any) => Number(c.index) === idx).value);
      if (pre === 0n && post !== 0n) n++;
    }
    const all = [...(e.balanceChanges ?? []), ...(e.nonceChanges ?? []), ...(e.codeChanges ?? [])];
    if (all.some((c: any) => Number(c.index) === idx) && !all.some((c: any) => Number(c.index) < idx)) {
      const [b, nn, code] = await Promise.all([provider.getBalance(e.address, bn - 1), provider.getTransactionCount(e.address, bn - 1), provider.getCode(e.address, bn - 1)]);
      if (b === 0n && nn === 0 && code === "0x") accounts++;
    }
  }
  return { gasUsed: Number(rc.gasUsed), newSlots: n, newAccounts: accounts };
}

async function main() {
  const provider = makeProvider();
  const st = JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8"));
  const sep = sched("gas-schedule.json");
  const main_ = sched("gas-schedule-mainnet.json");
  const slotDiff = Number(sep.newSlotSstoreGas) - Number(main_.newSlotSstoreGas);
  const accDiff = Number(sep.newAccountSurcharge) - 25_000;
  const eq = (r: { gasUsed: number; newSlots: number; newAccounts: number }) => r.gasUsed - r.newSlots * slotDiff - r.newAccounts * accDiff;

  const rows: any[] = [];
  const add = async (flow: string, i: number, step: string, hash: string) => {
    const r = await newSlots(provider, hash);
    rows.push({ flow, i, step, hash, ...r, mainnetEq: eq(r) });
  };
  for (const r of st.t1 ?? []) await add("T1 private transfer (K only)", r.i, "privateTransfer", r.tx.hash);
  for (const r of st.t2 ?? []) for (const s of ["open", "guess", "finalize"]) await add("T2 view (real PIN)", r.i, s, r[s].hash);
  for (const r of st.t3views ?? []) for (const s of ["open", "guess", "finalize"]) await add("T3 view (duress PIN)", r.i, s, r[s].hash);
  for (const r of st.t3transfers ?? []) for (const s of ["open", "guess", "finalize"]) await add(`T3 transfer (${r.mode})`, r.k, s, r[s].hash);

  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
  const by: Record<string, any> = {};
  for (const r of rows) {
    const k = `${r.flow} · ${r.step}`;
    (by[k] ??= { gas: [], slots: [], eq: [] }).gas.push(r.gasUsed);
    by[k].slots.push(r.newSlots);
    by[k].eq.push(r.mainnetEq);
  }
  const summary = Object.fromEntries(Object.entries(by).map(([k, v]: any) => [k, { n: v.gas.length, gasMedian: med(v.gas), newSlotsMedian: med(v.slots), mainnetEqMedian: med(v.eq), firstSample: { gas: v.gas[0], newSlots: v.slots[0] } }]));
  const out = { generatedAt: new Date().toISOString(), evidence: "[M] Sepolia block access lists; mainnet equivalent [I]", slotGas: { sepolia: Number(sep.newSlotSstoreGas), mainnet: Number(main_.newSlotSstoreGas) }, summary, rows };
  fs.writeFileSync(path.join(DIR, "slots.json"), JSON.stringify(out, null, 2) + "\n");
  for (const [k, v] of Object.entries<any>(summary)) console.log(`${k.padEnd(48)} n=${v.n} gas ${v.gasMedian} · new slots ${v.newSlotsMedian} · mainnet eq ${v.mainnetEqMedian}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.message ?? e).slice(0, 400));
    process.exit(1);
  });
