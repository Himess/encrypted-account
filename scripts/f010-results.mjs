// F0.10 — produces the Sepolia smoke-test summary (results/sepolia/f010-smoke.json) and prints markdown for RESULTS.md.
//   node scripts/f010-results.mjs            → summary JSON + markdown (stdout)
// Input: results/sepolia/{setup-f010,e1-f010,hot-path-f010,f010-live}.json and the F0.9 baseline (e1.json, hot-path.json).
import fs from "node:fs";
import path from "node:path";

const S = path.join(process.cwd(), "results", "sepolia");
const rd = (f) => (fs.existsSync(path.join(S, f)) ? JSON.parse(fs.readFileSync(path.join(S, f), "utf8")) : null);
const setup = rd("setup-f010.json");
const e1 = rd("e1-f010.json");
const hot = rd("hot-path-f010.json");
const live = rd("f010-live.json");
const e1b = rd("e1.json");
const hotb = rd("hot-path.json");
const s = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(1));
const n = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US"));
const sum = (o) => o?.summary;

const deployGas = setup ? Object.values(setup.deploys).reduce((a, t) => a + Number(t.gasUsed ?? 0), 0) : null;
const spentWei = (o) => (o?.samples ?? []).flatMap((x) => Object.values(x.tx ?? {})).reduce((a, t) => a + BigInt(t.costWei ?? "0"), 0n);
const out = {
  evidence: "[M] Sepolia",
  generatedAtUtc: new Date().toISOString(),
  deploy: setup && { contracts: setup.contracts, runtimeBytes: setup.runtimeBytes, totalGas: deployGas },
  accounts: setup?.accounts,
  e1: sum(e1) && { n: sum(e1).nOk, failures: e1.failures?.length ?? 0, totalMs: sum(e1).totalMs, clickToFinalizeMs: sum(e1).clickToFinalizeMs, phases: sum(e1).phases, gas: sum(e1).gas, hcu: sum(e1).hcu, meterChecks: sum(e1).meterChecks, challengeSource: e1.samples?.[0]?.challengeSource },
  hot: sum(hot) && { n: sum(hot).nOk, failures: hot.failures?.length ?? 0, totalMs: sum(hot).totalMs, phases: sum(hot).phases, gas: sum(hot).gas, hcu: sum(hot).hcu, meterChecks: sum(hot).meterChecks },
  baselineF09: { e1: sum(e1b)?.totalMs, hot: sum(hotb)?.totalMs, e1Gas: sum(e1b)?.gas, hotGas: sum(hotb)?.gas },
  live,
  spentEthSamples: Number(spentWei(e1) + spentWei(hot)) / 1e18,
};
fs.writeFileSync(path.join(S, "f010-smoke.json"), JSON.stringify(out, null, 2));

const g = (o, k) => o?.gas?.[k]?.p50;
const lines = [];
lines.push("### Sepolia smoke test [M] — `results/sepolia/{setup-f010,e1-f010,hot-path-f010,f010-live,f010-smoke}.json`");
lines.push("");
if (setup) {
  lines.push(
    `- **Deployment:** F0.10 build (\`results/sepolia/f010/build.json\`) 7 contracts, ${n(deployGas)} gas in total; EncryptedAccount \`${setup.contracts.EncryptedAccount}\`, factory \`${setup.contracts.EncryptedAccountFactory}\`, TauBench \`${setup.contracts.TauBench}\`.`,
  );
  for (const [k, a] of Object.entries(setup.accounts)) {
    lines.push(`- **${k} account** \`${a.address}\`: setup ${n(a.totalGas)} gas, ${n(a.totalHcu)} HCU; E_addr = watchtower, EIP-712 consent accepted on the live chain (nonce ${a.escape.nonce}, verified ${new Date(a.escape.verifiedAt * 1000).toISOString().slice(0, 16)} UTC).`);
  }
}
if (out.e1 && out.hot) {
  lines.push("");
  lines.push("| Flow (n = 5) | p50 | p95 | max | F0.9 baseline (n = 30) p50 / p95 |");
  lines.push("|---|---:|---:|---:|---:|");
  lines.push(`| PIN flow (E1) | ${s(out.e1.totalMs.p50)} s | ${s(out.e1.totalMs.p95)} s | ${s(out.e1.totalMs.max)} s | ${s(out.baselineF09.e1?.p50)} / ${s(out.baselineF09.e1?.p95)} s |`);
  lines.push(`| K-only hot path | ${s(out.hot.totalMs.p50)} s | ${s(out.hot.totalMs.p95)} s | ${s(out.hot.totalMs.max)} s | ${s(out.baselineF09.hot?.p50)} / ${s(out.baselineF09.hot?.p95)} s |`);
  lines.push("");
  lines.push(
    `- ${out.e1.n} PIN samples were correct and executed, ${out.hot.n} hot-path samples executed (errors: ${out.e1.failures} / ${out.hot.failures}). Challenge source: ${out.e1.challengeSource ?? "?"}; challenge step ${s(out.e1.phases?.challengeMs?.p50)} s (an RPC read in F0.9).`,
  );
  lines.push(
    `- Live gas (p50): op open ${n(g(out.e1, "open"))}, submitGuess ${n(g(out.e1, "submitGuess"))}, finalizeGuess ${n(g(out.e1, "finalizeGuess"))}, executeOp ${n(g(out.e1, "executeOp"))}; K-only request ${n(g(out.hot, "request"))}, finalizeEvaluation ${n(g(out.hot, "finalizeEvaluation"))}. F0.9 baseline: submitGuess ${n(out.baselineF09.e1Gas?.submitGuess?.p50)}, finalizeGuess ${n(out.baselineF09.e1Gas?.finalizeGuess?.p50)}, K-only request ${n(out.baselineF09.hotGas?.request?.p50)}.`,
  );
  lines.push(`- HCU live meter checks: PIN ${JSON.stringify(out.e1.meterChecks)}, hot path ${JSON.stringify(out.hot.meterChecks)}.`);
}
if (live) {
  lines.push("");
  for (const t of live.tau) {
    lines.push(
      `- **τ v2 live (D = ${n(t.D)}):** 4 draws, offsets ${t.v2.offsets.join(", ")} → in range: ${t.v2.inRange ? "yes" : "NO"}; HCU ${n(t.v2.hcu?.total)} (meter: ${t.v2.hcu?.meterCheck}); tx \`${t.v2.tx}\`.${t.v1 ? ` v1 in the same range: offsets ${t.v1.offsets.join(", ")} (stuck at L_min: ${t.v1.allLmin ? "yes" : "no"}).` : ""}`,
    );
  }
  lines.push(`- **K53 live:** c in the receipt = c on chain: ${live.k53.receiptMatchesChain ? "yes" : "NO"}; submitGuess eth_call with a stale c read from the block before the op appeared → \`${live.k53.staleGuessRevert}\`.`);
  lines.push(`- **K55 live:** factory eth_call with a consent signed by a key other than E_addr → \`${live.k55.forgedConsentRevert}\`.`);
  lines.push(`- **Balances after:** user ${live.balances.user} ETH, watchtower ${live.balances.watchtower} ETH.`);
}
console.log(lines.join("\n"));
