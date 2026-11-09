/**
 * F0.15 — new storage slots per transaction, read from the block access list (EIP-7928, eth_getBlockAccessList), per
 * address. A slot is "new" when it is 0 before the transaction and nonzero after it. On Sepolia's current gas schedule
 * one such SSTORE costs ≈ 111k gas, on mainnet ≈ 22.4k (results/sepolia/gas-schedule*.json), so this count, not the
 * number of FHE operations, sets most of the gas difference between the two networks.
 *
 * Runs compared (same account setup, method, delays, limits and amount; f09-run.ts):
 *   f010  — the storage layout before F0.15        f015 — per-track guess records, packed counters, no stored op hash
 *   f015b — f015 + epoch counters that restart at 1 instead of 0
 * Each transaction's storage writes are attributed to the account, the fhEVM ACL, the fhEVM executor, its HCU limit
 * contract, the recipient, or "other". Samples fall in three classes: the account's first sample ("first", one-time
 * slots), the first sample after a UTC epoch change ("dayFirst", the day counters restart) and the rest ("steady").
 *
 *   npx hardhat run scripts/sepolia/f015-slots.ts
 * Output: results/sepolia/f015-slots.json (resumes: transactions already analysed are not read again)
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { OUT_DIR, writeJson } from "../lib/live";
import { makeProvider } from "../lib/net";
import { readJson } from "./f09-lib";

const OUT = "f015-slots.json";
const RUNS = ["f010", "f015", "f015b"] as const;
const FLOWS = [
  { file: "e1", steps: ["open", "submitGuess", "finalizeGuess", "executeOp"], name: "PIN path (ETH transfer to a new address)" },
  { file: "hot-path", steps: ["request", "finalizeEvaluation"], name: "K-only hot path (ETH transfer to a known recipient)" },
] as const;

type Counts = { new: number; changed: number; cleared: number };
type TxSlots = {
  hash: string;
  block: number;
  blockTimestamp?: number;
  balIndex: number;
  gasUsed: number;
  newSlots: number;
  changedSlots: number;
  clearedSlots: number;
  newAccounts: number;
  byLabel: Record<string, Counts>;
  newSlotList: { label: string; address: string; key: string; post: string }[];
};

const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

async function txSlots(provider: any, hash: string, labelOf: (a: string) => string): Promise<TxSlots> {
  const rc = await provider.getTransactionReceipt(hash);
  if (!rc) throw new Error(`no receipt for ${hash}`);
  const idx = rc.index + 1; // BAL index: 0 = pre-block system calls, i + 1 = transaction i
  const bn = rc.blockNumber;
  const bal: any[] = await provider.send("eth_getBlockAccessList", [ethers.toQuantity(bn)]);
  const blockTimestamp = Number((await provider.getBlock(bn)).timestamp);
  const out: TxSlots = { hash, block: bn, blockTimestamp, balIndex: idx, gasUsed: Number(rc.gasUsed), newSlots: 0, changedSlots: 0, clearedSlots: 0, newAccounts: 0, byLabel: {}, newSlotList: [] };
  const bump = (label: string, k: keyof Counts) => {
    out.byLabel[label] ??= { new: 0, changed: 0, cleared: 0 };
    out.byLabel[label][k]++;
  };
  for (const e of bal) {
    const label = labelOf(e.address);
    const mine = (e.storageChanges ?? []).filter((sc: any) => sc.changes.some((c: any) => Number(c.index) === idx));
    // pre-values: an earlier write in the same block, else the state at the end of the previous block
    const pres = await Promise.all(
      mine.map(async (sc: any) => {
        const earlier = sc.changes.filter((c: any) => Number(c.index) < idx).sort((a: any, b: any) => Number(b.index) - Number(a.index))[0];
        return earlier ? BigInt(earlier.value) : BigInt(await provider.getStorage(e.address, sc.key, bn - 1));
      }),
    );
    mine.forEach((sc: any, k: number) => {
      const post = BigInt(sc.changes.find((c: any) => Number(c.index) === idx).value);
      const pre = pres[k];
      if (pre === 0n && post !== 0n) {
        out.newSlots++;
        bump(label, "new");
        out.newSlotList.push({ label, address: ethers.getAddress(e.address), key: ethers.toBeHex(BigInt(sc.key), 32), post: ethers.toBeHex(post) });
      } else if (pre !== 0n && post === 0n) {
        out.clearedSlots++;
        bump(label, "cleared");
      } else {
        out.changedSlots++;
        bump(label, "changed");
      }
    });
    const all = [...(e.balanceChanges ?? []), ...(e.nonceChanges ?? []), ...(e.codeChanges ?? [])];
    if (all.some((c: any) => Number(c.index) === idx) && !all.some((c: any) => Number(c.index) < idx)) {
      const [b, n, code] = await Promise.all([provider.getBalance(e.address, bn - 1), provider.getTransactionCount(e.address, bn - 1), provider.getCode(e.address, bn - 1)]);
      if (b === 0n && n === 0 && code === "0x") out.newAccounts++;
    }
  }
  return out;
}

async function labels(provider: any, run: string) {
  const setup = readJson(`setup-${run}.json`);
  if (!setup) return null;
  const m = new Map<string, string>();
  const put = (a: string | undefined | null, l: string) => a && m.set(a.toLowerCase(), l);
  put(setup.implConfig?.aclAddress, "fhevm ACL");
  put(setup.implConfig?.executorAddress, "fhevm executor");
  try {
    const ex = new ethers.Contract(setup.implConfig.executorAddress, ["function getHCULimitAddress() view returns (address)", "function getInputVerifierAddress() view returns (address)"], provider);
    put(await ex.getHCULimitAddress(), "fhevm HCU limit");
    put(await ex.getInputVerifierAddress(), "fhevm input verifier");
  } catch {
    /* older executor: left as "other" */
  }
  for (const [k, a] of Object.entries<any>(setup.accounts ?? {})) put(a.address, `account (${k})`);
  return m;
}

async function main() {
  const provider = makeProvider();
  const prev = readJson(OUT);
  const cache = new Map<string, TxSlots>();
  for (const r of prev?.txs ?? []) cache.set(r.hash, r);
  const sepSchedule = readJson("gas-schedule.json");
  const mainSchedule = readJson("gas-schedule-mainnet.json");
  const slotGas = { sepolia: Number(sepSchedule.newSlotSstoreGas), mainnet: Number(mainSchedule.newSlotSstoreGas) };
  // a value transfer that creates an account: Sepolia measured; mainnet 25,000 (the pre-fork protocol constant, [I])
  const accountGas = { sepolia: Number(sepSchedule.newAccountSurcharge), mainnet: 25_000 };
  /** Today's mainnet schedule equivalent [I]: the live Sepolia gas minus the schedule difference of the state growth. */
  const mainnetEq = (gas: number, slots: number, accounts: number) => gas - slots * (slotGas.sepolia - slotGas.mainnet) - accounts * (accountGas.sepolia - accountGas.mainnet);

  const runs: any = {};
  for (const run of RUNS) {
    const lab = await labels(provider, run);
    if (!lab) {
      console.log(`${run}: no setup-${run}.json — skipped`);
      continue;
    }
    runs[run] = {};
    for (const flow of FLOWS) {
      const data = readJson(`${flow.file}-${run}.json`);
      if (!data?.samples?.length) {
        console.log(`${run}: no ${flow.file}-${run}.json samples — skipped`);
        continue;
      }
      const rows: any[] = [];
      for (const s of data.samples) {
        const recipient = (s.to ?? data.knownRecipient ?? "").toLowerCase();
        const labelOf = (a: string) => lab.get(a.toLowerCase()) ?? (a.toLowerCase() === recipient ? "recipient" : `other ${ethers.getAddress(a)}`);
        const row: any = { i: s.i, steps: {} };
        for (const step of flow.steps) {
          const tx = s.tx?.[step];
          if (!tx?.hash) continue;
          let r = cache.get(tx.hash);
          if (!r) {
            r = await txSlots(provider, tx.hash, labelOf);
            cache.set(tx.hash, r);
            writeJson(OUT, { ...(prev ?? {}), txs: [...cache.values()] }); // checkpoint
          }
          // the block time comes from the chain (the run files sometimes record 0)
          if (r.blockTimestamp == null) r.blockTimestamp = Number((await provider.getBlock(r.block)).timestamp);
          row.steps[step] = { hash: r.hash, block: r.block, blockTimestamp: r.blockTimestamp, gasUsed: r.gasUsed, newSlots: r.newSlots, changedSlots: r.changedSlots, clearedSlots: r.clearedSlots, newAccounts: r.newAccounts, byLabel: r.byLabel };
          console.log(`${run} ${flow.file}#${s.i} ${step.padEnd(18)} new ${String(r.newSlots).padStart(2)} · changed ${r.changedSlots} · cleared ${r.clearedSlots} · accounts ${r.newAccounts} · gas ${r.gasUsed}`);
        }
        rows.push(row);
      }
      const pick = (sel: any[]) =>
        Object.fromEntries(
          flow.steps.map((step) => {
            const xs = sel.map((r) => r.steps[step]).filter(Boolean);
            const lbls = [...new Set(xs.flatMap((x: any) => Object.keys(x.byLabel)))];
            return [
              step,
              {
                n: xs.length,
                newSlots: med(xs.map((x: any) => x.newSlots)),
                changedSlots: med(xs.map((x: any) => x.changedSlots)),
                clearedSlots: med(xs.map((x: any) => x.clearedSlots)),
                newAccounts: med(xs.map((x: any) => x.newAccounts)),
                gasUsed: med(xs.map((x: any) => x.gasUsed)),
                newByLabel: Object.fromEntries(lbls.map((l) => [l, med(xs.map((x: any) => x.byLabel[l]?.new ?? 0))]).filter(([, v]) => v)),
              },
            ];
          }),
        );
      // classes: the account's first sample; the first sample of a new UTC epoch (the day counters restart); the rest
      for (const r of rows) {
        const t0 = r.steps.open ?? r.steps.request; // the epoch rolls in this transaction or right after it
        r.epoch = t0?.blockTimestamp ? Math.floor(t0.blockTimestamp / 86400) : null;
      }
      rows.forEach((r, k) => (r.cls = r.i === 0 ? "first" : r.epoch !== rows[k - 1]?.epoch ? "dayFirst" : "steady"));
      const total = (agg: any, k: string) => flow.steps.reduce((t, step) => t + (agg[step]?.[k] ?? 0), 0);
      const out: any = { flow: flow.name, account: data.account, samples: rows };
      for (const cls of ["first", "steady", "dayFirst"]) {
        const sel = rows.filter((r) => r.cls === cls);
        if (!sel.length) continue;
        const agg = pick(sel);
        out[cls] = agg;
        out[`${cls}Total`] = { n: sel.length, newSlots: total(agg, "newSlots"), newAccounts: total(agg, "newAccounts"), gasUsed: total(agg, "gasUsed") };
      }
      runs[run][flow.file] = out;
    }
  }

  const compareRuns = (ra: string, rb: string, cls: string) => {
    const res: any = {};
    for (const flow of FLOWS) {
      const a = runs[ra]?.[flow.file];
      const b = runs[rb]?.[flow.file];
      const ta = a?.[`${cls}Total`];
      const tb = b?.[`${cls}Total`];
      if (!ta || !tb) continue;
      const steps = Object.fromEntries(
        flow.steps.map((step) => {
          const x = a[cls][step];
          const y = b[cls][step];
          const dSlots = (y?.newSlots ?? 0) - (x?.newSlots ?? 0);
          return [step, { newSlots: [x?.newSlots, y?.newSlots], gasUsed: [x?.gasUsed, y?.gasUsed], dGas: (y?.gasUsed ?? 0) - (x?.gasUsed ?? 0), dSlots, slotGasSepolia: dSlots * slotGas.sepolia, slotGasMainnet: dSlots * slotGas.mainnet }];
        }),
      );
      const dSlots = tb.newSlots - ta.newSlots;
      const eqA = mainnetEq(ta.gasUsed, ta.newSlots, ta.newAccounts);
      const eqB = mainnetEq(tb.gasUsed, tb.newSlots, tb.newAccounts);
      res[flow.file] = {
        flow: flow.name,
        samples: [ta.n, tb.n],
        steps,
        total: {
          newSlots: [ta.newSlots, tb.newSlots],
          newAccounts: [ta.newAccounts, tb.newAccounts],
          gasUsed: [ta.gasUsed, tb.gasUsed],
          dGas: tb.gasUsed - ta.gasUsed,
          dGasPct: Number((((tb.gasUsed - ta.gasUsed) / ta.gasUsed) * 100).toFixed(1)),
          dSlots,
          slotGasSepolia: dSlots * slotGas.sepolia,
          slotGasMainnet: dSlots * slotGas.mainnet,
          mainnetEquivalent: [eqA, eqB],
          mainnetEquivalentDPct: Number((((eqB - eqA) / eqA) * 100).toFixed(1)),
        },
      };
    }
    return res;
  };
  const compare: any = {
    "f010→f015 steady": compareRuns("f010", "f015", "steady"),
    "f015→f015b steady": compareRuns("f015", "f015b", "steady"),
    "f015→f015b dayFirst": compareRuns("f015", "f015b", "dayFirst"),
    "f010→f015b steady": compareRuns("f010", "f015b", "steady"),
  };

  writeJson(OUT, {
    evidence: "[M] Sepolia (EIP-7928 block access list, eth_getBlockAccessList; pre-values from the same block or eth_getStorageAt at block − 1)",
    generatedAtUtc: new Date().toISOString(),
    rule: "new slot = value 0 before the transaction, nonzero after it; first = the account's first sample; dayFirst = the first sample in a new UTC epoch; steady = the rest; values are medians",
    slotGas,
    accountGas,
    mainnetEquivalentRule: "[I] live gas − newSlots × (slotGas.sepolia − slotGas.mainnet) − newAccounts × (accountGas.sepolia − accountGas.mainnet)",
    runs,
    compare,
    txs: [...cache.values()],
  });
  for (const [name, cmp] of Object.entries<any>(compare)) {
    for (const c of Object.values<any>(cmp)) {
      console.log(
        `\n[${name}] ${c.flow} (n ${c.samples.join("/")}): new slots ${c.total.newSlots[0]} → ${c.total.newSlots[1]} (Δ ${c.total.dSlots}) · Sepolia gas ${c.total.gasUsed[0]} → ${c.total.gasUsed[1]} (${c.total.dGasPct}%) · today's mainnet equivalent ${c.total.mainnetEquivalent[0]} → ${c.total.mainnetEquivalent[1]} (${c.total.mainnetEquivalentDPct}%)`,
      );
      for (const [s, v] of Object.entries<any>(c.steps)) console.log(`  ${s.padEnd(18)} slots ${v.newSlots[0]} → ${v.newSlots[1]} · gas ${v.gasUsed[0]} → ${v.gasUsed[1]}`);
    }
  }
  console.log(`→ ${path.join(OUT_DIR, OUT)}`);
  provider.destroy();
  void fs;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
