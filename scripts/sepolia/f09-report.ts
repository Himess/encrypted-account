/**
 * F0.9 step 7 — cost model and summary. Live Sepolia gas [M] next to mock gas [Mock]; to explain differences above 10%,
 * state growth is counted for each flow's representative transaction from the block access list (EIP-7928,
 * eth_getBlockAccessList): new storage slots (0 → ≠0), new accounts, deposited code bytes. From the difference between
 * Sepolia's gas schedule (results/sepolia/gas-schedule.json) and mainnet's (gas-schedule-mainnet.json) a "today's mainnet
 * schedule equivalent" [I] is computed:  equivalent ≈ live − newSlots·ΔSlot − newAccounts·ΔAccount − codeBytes·ΔByte.
 *
 *   npx hardhat run scripts/sepolia/f09-report.ts
 * Output: results/sepolia/cost-model-live.{json,csv}, results/sepolia/f09-summary.json
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { OUT_DIR, writeJson } from "../lib/live";
import { makeProvider } from "../lib/net";
import { readJson, summarize } from "./f09-lib";

type Row = {
  flow: string;
  source: string;
  mockGas: number | null;
  liveGas: { n: number; median: number; min: number; max: number } | null;
  diffPct: number | null;
  mockHcu: number | null;
  liveHcu: number | null;
  liveHcuDepth: number | null;
  hcuMeter: string | null;
  sampleTx: string | null;
  state?: StateDelta | null;
  oldScheduleEstimate?: number | null;
  mockOverheadEstimate?: number | null;
  note?: string;
};

type StateDelta = { newSlots: number; changedSlots: number; clearedSlots: number; newAccounts: number; codeBytes: number; fheOps: number | null; balIndex: number; block: number };

const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

async function stateDelta(provider: any, hash: string, fheOps: number | null): Promise<StateDelta | null> {
  try {
    const rc = await provider.getTransactionReceipt(hash);
    if (!rc) return null;
    const idx = rc.index + 1; // BAL index: 0 = pre-block system calls, i+1 = transaction i
    const bn = rc.blockNumber;
    const bal: any[] = await provider.send("eth_getBlockAccessList", [ethers.toQuantity(bn)]);
    let newSlots = 0;
    let changedSlots = 0;
    let clearedSlots = 0;
    let newAccounts = 0;
    let codeBytes = 0;
    for (const e of bal) {
      for (const sc of e.storageChanges ?? []) {
        const mine = sc.changes.find((c: any) => Number(c.index) === idx);
        if (!mine) continue;
        const earlier = sc.changes.filter((c: any) => Number(c.index) < idx).sort((a: any, b: any) => Number(b.index) - Number(a.index))[0];
        const pre = earlier ? BigInt(earlier.value) : BigInt(await provider.getStorage(e.address, sc.key, bn - 1));
        const post = BigInt(mine.value);
        if (pre === 0n && post !== 0n) newSlots++;
        else if (pre !== 0n && post === 0n) clearedSlots++;
        else changedSlots++;
      }
      for (const cc of e.codeChanges ?? []) if (Number(cc.index) === idx) codeBytes += (String(cc.code ?? cc.value ?? "0x").length - 2) / 2;
      const all = [...(e.balanceChanges ?? []), ...(e.nonceChanges ?? []), ...(e.codeChanges ?? [])];
      if (all.some((c: any) => Number(c.index) === idx) && !all.some((c: any) => Number(c.index) < idx)) {
        const [b, n, code] = await Promise.all([provider.getBalance(e.address, bn - 1), provider.getTransactionCount(e.address, bn - 1), provider.getCode(e.address, bn - 1)]);
        if (b === 0n && n === 0 && code === "0x") newAccounts++;
      }
    }
    return { newSlots, changedSlots, clearedSlots, newAccounts, codeBytes, fheOps, balIndex: idx, block: bn };
  } catch (e: any) {
    console.log(`  BAL unreadable (${hash.slice(0, 10)}…): ${String(e?.message ?? e).slice(0, 100)}`);
    return null;
  }
}

async function main() {
  const provider = makeProvider();
  const mock = readJson("../cost-model-mock.json") ?? JSON.parse(fs.readFileSync(path.join(OUT_DIR, "..", "cost-model-mock.json"), "utf8"));
  const setup = readJson("setup.json");
  const e1 = readJson("e1.json");
  const hot = readJson("hot-path.json");
  const live = readJson("live-checks.json");
  const gs = readJson("gas-schedule.json");
  const gsMain = readJson("gas-schedule-mainnet.json");
  if (!setup || !e1 || !hot) throw new Error("setup.json / e1.json / hot-path.json missing");

  const mockRow = (name: string) => mock.rows.find((r: any) => r.flow === name) ?? null;
  const dSlot = (gs?.newSlotSstoreGas ?? 110983) - (gsMain?.newSlotSstoreGas ?? 22445);
  const dAcct = (gs?.newAccountSurcharge ?? 186391) - 25_000;
  const dByte = (gs?.codeDepositPerByte ?? 1542) - (gsMain?.codeDepositPerByte ?? 202);

  const rows: Row[] = [];
  const add = async (flow: string, source: string, mockName: string | null, txs: any[], note?: string) => {
    const t = txs.filter(Boolean);
    const gas = t.map((x) => Number(x.gasUsed));
    const m = mockName ? mockRow(mockName) : null;
    const median = gas.length ? med(gas) : NaN;
    const rep = t.length ? t.reduce((best, x) => (Math.abs(Number(x.gasUsed) - median) < Math.abs(Number(best.gasUsed) - median) ? x : best), t[0]) : null;
    const hcus = t.map((x) => x.hcu?.total).filter((v: any) => typeof v === "number");
    const row: Row = {
      flow,
      source,
      mockGas: m ? m.gas : null,
      liveGas: gas.length ? { n: gas.length, median, min: Math.min(...gas), max: Math.max(...gas) } : null,
      diffPct: m && gas.length ? Math.round(((median - m.gas) / m.gas) * 1000) / 10 : null,
      mockHcu: m ? m.hcuTotal : null,
      liveHcu: hcus.length ? med(hcus) : null,
      liveHcuDepth: rep?.hcu?.depth ?? null,
      hcuMeter: rep?.hcu?.meterCheck ?? null,
      sampleTx: rep?.hash ?? null,
      note,
    };
    if (rep?.hash) {
      row.state = await stateDelta(provider, rep.hash, rep.hcu?.fheOps ?? null);
      if (row.state) {
        row.oldScheduleEstimate = Number(rep.gasUsed) - row.state.newSlots * dSlot - row.state.newAccounts * dAcct - row.state.codeBytes * dByte;
        if (row.mockGas !== null) row.mockOverheadEstimate = row.mockGas - row.oldScheduleEstimate;
      }
    }
    rows.push(row);
    console.log(
      `${flow.padEnd(48)} mock ${String(row.mockGas ?? "-").padStart(9)} · live ${String(row.liveGas?.median ?? "-").padStart(9)} (${row.diffPct ?? "-"}%) · new slots ${row.state?.newSlots ?? "?"} · new accounts ${row.state?.newAccounts ?? "?"} · old schedule ≈ ${row.oldScheduleEstimate ?? "?"}`,
    );
  };

  const setupRows = (step: string) => Object.values<any>(setup.accounts).map((a: any) => a.rows.find((r: any) => r.step === step)).filter(Boolean).map((r: any) => ({ gasUsed: r.gas, hash: r.tx, hcu: r.hcu === null ? null : { total: r.hcu, depth: r.hcuDepth, meterCheck: r.meterCheck } }));
  // setup.json rows are simplified; use the full records in state-baseline.json for HCU's fheOps field
  const st = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "state-baseline.json"), "utf8"));
  const fullSetup = (step: string) => Object.values<any>(st.accounts ?? {}).map((a: any) => a.setup?.[step]).filter(Boolean);
  void setupRows;
  const e1ok = e1.samples.filter((s: any) => s.ok);
  const hotok = hot.samples.filter((s: any) => s.ok && s.executed);

  await add("factory.createAccount (clone + initialize)", "setup ×3", "factory.createAccount (clone + initialize)", fullSetup("createAccount"));
  await add("setupPin", "setup ×3", "setupPin (fingerprint + duress slot select/rand)", fullSetup("setupPin"));
  await add("setupAsset (ETH; incl. τ draw)", "setup ×3", "setupAsset (L_min, L, L_big + τ draw)", fullSetup("setupAsset"));
  await add("setupKnown (12 eaddress / proof)", "setup ×6", "setupKnown (12 eaddress / proof)", [...fullSetup("setupKnownR0"), ...fullSetup("setupKnownR12")]);
  await add("setupKnown (6 eaddress)", "setup ×3", null, fullSetup("setupKnownR24"));
  await add("setupKnown spenders (10 eaddress)", "setup ×3", null, fullSetup("setupKnownS0"));
  await add("setupRoles", "setup ×3", null, fullSetup("setupRoles"));
  await add("arm", "setup ×3", "arm", fullSetup("arm"));
  await add("requestTransfer K-only (isIn N=30 + threshold + tripwire)", `hot ×${hotok.length}`, "requestTransfer K-only (isIn N=30 + threshold + sticky tripwire)", hotok.map((s: any) => s.tx.request));
  await add("finalizeEvaluation (KMS proof + transfer)", `hot ×${hotok.length}`, "finalizeEvaluation (KMS proof + transfer)", hotok.map((s: any) => s.tx.finalizeEvaluation));
  await add("requestTransfer PIN path (opens op)", `e1 ×${e1ok.length}`, "requestTransfer PIN path (opens op)", e1ok.map((s: any) => s.tx.open));
  await add("submitGuess (transfer; okAny + isDuress + big)", `e1 ×${e1ok.length}`, "submitGuess (transfer; okAny + isDuress + big)", e1ok.map((s: any) => s.tx.submitGuess));
  await add("finalizeGuess (2-handle KMS proof)", `e1 ×${e1ok.length}`, "finalizeGuess (2-handle KMS proof)", e1ok.map((s: any) => s.tx.finalizeGuess));
  await add("executeOp transfer (+ auto-add to known list)", `e1 ×${e1ok.length}`, "executeOp transfer (+ auto-add to known list: isIn + select)", e1ok.map((s: any) => s.tx.executeOp), "recipient is a new address in every sample (new-account surcharge)");
  const L = live?.checks ?? {};
  if (L.admin) {
    await add("submitGuess (admin; okAny + isDuress)", "live ×1", "submitGuess (admin; okAny + isDuress)", [L.admin.submitGuessAdmin]);
    await add("finalizeGuess + resetTrip (τ redrawn)", "live ×1", "finalizeGuess + resetTrip (τ redrawn)", [L.admin.finalizeResetTrip]);
    await add("tightenLimits (K-only; 4× encrypted min)", "live ×1", "tightenLimits (K-only; 4× min)", [L.admin.tightenLimits]);
    await add("removeKnown (K-only; select)", "live ×1", "removeKnown (K-only; select)", [L.admin.removeKnown]);
  }
  if (L.escape) {
    await add("startEscape (no FHE)", "live ×1", "startEscape (no FHE)", [L.escape.startEscape]);
    await add("executeEscape (no FHE; ETH only)", "live ×1", "executeEscape (no FHE; ETH + 1 token)", [L.escape.executeEscape], "mock: ETH + 1 token; live: ETH only");
  }
  if (L.isIn) {
    await add("Bench isIn N=30", "live ×1", "isIn N=30", [L.isIn.isIn30]);
    await add("Bench isIn N=60", "live ×1", "isIn N=60", [L.isIn.isIn60]);
  }
  if (L.aa) {
    await add("AA handleOps: requestTransfer (PIN path)", "live ×1", null, [L.aa.openViaUserOp?.tx]);
    await add("AA handleOps: submitGuess", "live ×1", null, [L.aa.guessViaUserOp?.tx]);
  }

  // flow totals
  const sumMed = (names: string[], key: "median" | "mock") =>
    names.reduce((s, n) => {
      const r = rows.find((x) => x.flow === n);
      const v = key === "median" ? r?.liveGas?.median : r?.mockGas;
      return s + (v ?? 0);
    }, 0);
  const sumOld = (names: string[]) => names.reduce((s, n) => s + (rows.find((x) => x.flow === n)?.oldScheduleEstimate ?? 0), 0);
  const hotNames = ["requestTransfer K-only (isIn N=30 + threshold + tripwire)", "finalizeEvaluation (KMS proof + transfer)"];
  const pinNames = ["requestTransfer PIN path (opens op)", "submitGuess (transfer; okAny + isDuress + big)", "finalizeGuess (2-handle KMS proof)", "executeOp transfer (+ auto-add to known list)"];
  const setupLive = Object.values<any>(setup.accounts)[0].totalGas;
  const totals = {
    kOnlyTransfer: { live: sumMed(hotNames, "median"), mock: sumMed(hotNames, "mock"), oldScheduleEstimate: sumOld(hotNames) },
    pinTransfer: { live: sumMed(pinNames, "median"), mock: sumMed(pinNames, "mock"), oldScheduleEstimate: sumOld(pinNames) },
    setupOneAssetLive: setupLive,
    deployLiveGas: Object.values<any>(setup.deploys ?? {}).reduce((s: number, d: any) => s + Number(d.gasUsed ?? 0), 0),
  };

  const schedule = {
    sepolia: gs ? { block: gs.block, gasLimit: gs.gasLimit, newSlot: gs.newSlotSstoreGas, codeByte: gs.codeDepositPerByte, newAccountSurcharge: gs.newAccountSurcharge, newHeaderFields: gs.newHeaderFields } : null,
    mainnet: gsMain ? { block: gsMain.block, gasLimit: gsMain.gasLimit, newSlot: gsMain.newSlotSstoreGas, codeByte: gsMain.codeDepositPerByte, baseFeeGwei: gsMain.baseFeeGwei } : null,
    deltas: { newSlot: dSlot, newAccount: dAcct, codeByte: dByte },
  };
  const out = { evidence: "[M] Sepolia gas; [Mock] Round 1; state growth [M] BAL; old-schedule equivalent [I]", generatedAtUtc: new Date().toISOString(), schedule, rows, totals };
  writeJson("cost-model-live.json", out);
  const csv = [
    "flow,source,mock_gas,live_gas_median,live_gas_min,live_gas_max,n,diff_pct,mock_hcu,live_hcu,live_hcu_depth,hcu_meter,new_slots,new_accounts,code_bytes,fhe_ops,old_schedule_estimate,mock_overhead_estimate,sample_tx,note",
    ...rows.map((r) =>
      [
        `"${r.flow}"`,
        `"${r.source}"`,
        r.mockGas ?? "",
        r.liveGas?.median ?? "",
        r.liveGas?.min ?? "",
        r.liveGas?.max ?? "",
        r.liveGas?.n ?? "",
        r.diffPct ?? "",
        r.mockHcu ?? "",
        r.liveHcu ?? "",
        r.liveHcuDepth ?? "",
        r.hcuMeter ?? "",
        r.state?.newSlots ?? "",
        r.state?.newAccounts ?? "",
        r.state?.codeBytes ?? "",
        r.state?.fheOps ?? "",
        r.oldScheduleEstimate ?? "",
        r.mockOverheadEstimate ?? "",
        r.sampleTx ?? "",
        `"${r.note ?? ""}"`,
      ].join(","),
    ),
  ].join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "cost-model-live.csv"), csv + "\n");

  // E1 / hot path summaries (the summaries written by the runner + recovery/failure counts)
  // inclusion analysis: wait until slot start, missed slots, delay from slot start until the receipt is seen
  const hdrCache = new Map<number, any>();
  const hdr = async (n: number) => {
    if (!hdrCache.has(n)) hdrCache.set(n, await provider.send("eth_getBlockByNumber", [ethers.toQuantity(n), false]));
    return hdrCache.get(n);
  };
  const incl: any[] = [];
  const pushTx = async (flow: string, kind: string, t: any) => {
    if (!t?.blockNumber) return;
    const b = await hdr(t.blockNumber);
    const p = await hdr(t.blockNumber - 1);
    const ts = Number(b.timestamp) * 1000;
    incl.push({
      flow,
      kind,
      inclusionMs: t.inclusionMs,
      slotGap: b.slotNumber !== undefined && p.slotNumber !== undefined ? Number(b.slotNumber) - Number(p.slotNumber) : null,
      blockAfterSent: t.blockNumber - t.sentBlock,
      sentToSlotStartMs: ts - Date.parse(t.sentAtUtc),
      slotStartToSeenMs: Date.parse(t.minedSeenAtUtc) - ts,
      blockIntervalS: Number(b.timestamp) - Number(p.timestamp),
    });
  };
  for (const s of e1ok) for (const k of ["open", "submitGuess", "finalizeGuess"]) await pushTx("e1", k, s.tx[k]);
  for (const s of hotok) for (const k of ["request", "finalizeEvaluation"]) await pushTx("hot", k, s.tx[k]);
  const inclusion = {
    n: incl.length,
    inclusionMs: summarize(incl.map((x) => x.inclusionMs)),
    slotStartToSeenMs: summarize(incl.map((x) => x.slotStartToSeenMs)),
    missedSlotShare: incl.filter((x) => (x.slotGap ?? 1) > 1).length / Math.max(1, incl.length),
    blockIntervalGt12Share: incl.filter((x) => x.blockIntervalS > 12).length / Math.max(1, incl.length),
    notInFirstBlockShare: incl.filter((x) => x.blockAfterSent > 1).length / Math.max(1, incl.length),
    slowOver15s: incl.filter((x) => x.inclusionMs > 15_000).map((x) => ({ flow: x.flow, kind: x.kind, inclusionMs: x.inclusionMs, slotGap: x.slotGap, blockAfterSent: x.blockAfterSent, blockIntervalS: x.blockIntervalS })),
  };
  writeJson("inclusion-analysis.json", { evidence: "[M] Sepolia block headers (slotNumber, timestamp)", generatedAtUtc: out.generatedAtUtc, summary: inclusion, rows: incl });
  console.log(`inclusion: n=${inclusion.n} p50 ${inclusion.inclusionMs.p50} ms p95 ${inclusion.inclusionMs.p95} ms · missed-slot share ${(inclusion.missedSlotShare * 100).toFixed(1)}% · not in first block ${(inclusion.notInFirstBlockShare * 100).toFixed(1)}%`);

  const summary = {
    generatedAtUtc: out.generatedAtUtc,
    e1: { account: e1.account, n: e1.samples.length, failures: e1.failures.length, summary: e1.summary },
    hot: { account: hot.account, n: hot.samples.length, failures: hot.failures.length, summary: hot.summary },
    live: live ? Object.fromEntries(Object.entries<any>(live.checks).map(([k, v]) => [k, v.pass])) : null,
    totals,
    schedule,
    inclusion,
  };
  writeJson("f09-summary.json", summary);
  console.log("\nTotals:", JSON.stringify(totals));
  provider.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
