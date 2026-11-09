/**
 * E1 — end-to-end time of the two-phase PIN flow on Sepolia (go/no-go criterion: p95 < 60 s, including Argon2id)
 * and the time of the A2 (K-only evaluation) flow. Evidence class: [M] (measured on testnet).
 *
 * ROUND 1 VERSION — in Round 2 it was replaced by the resumable measurement scripts under scripts/sepolia/.
 * The key is now read only from .env.sepolia (hardhat.config.ts); no key is typed on the command line:
 *   npx hardhat run scripts/burner.ts && npx hardhat run scripts/sepolia-e1.ts --network sepolia
 *
 * The Sepolia relayer does not require an API key.
 * Output: results/e1-sepolia.json (per-iteration breakdown, p50/p95, gas, tx hashes).
 */
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { guessValue, pinFingerprint, randomUint64 } from "../sdk/src";

const ENTRYPOINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"; // canonical v0.8 (only stored by the constructor)
const ETH = "0x0000000000000000000000000000000000000000";
const N = Number(process.env.E1_ITERATIONS ?? 10);
const PIN = process.env.E1_PIN ?? "482915";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
function pct(a: number[], p: number) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

async function publicDecryptWithRetry(handles: string[], timeoutMs = 300_000) {
  const t0 = now();
  let lastErr: unknown;
  while (now() - t0 < timeoutMs) {
    try {
      return { res: await hre.fhevm.publicDecrypt(handles), waitedMs: now() - t0 };
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw new Error(`publicDecrypt timeout: ${String(lastErr)}`);
}

async function main() {
  if (hre.network.name !== "sepolia") throw new Error("run with --network sepolia");
  try {
    await (hre.fhevm as any).initializeCLIApi?.();
  } catch {
    /* plugin may already be initialised */
  }
  const [signer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  console.log(`signer ${signer.address} balance ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(signer.address))} ETH`);

  // ── deployment
  const dep = async (name: string, libs?: Record<string, string>, ...args: unknown[]) => {
    const f = await hre.ethers.getContractFactory(name, libs ? { libraries: libs } : {});
    const c: any = await f.deploy(...args);
    await c.waitForDeployment();
    console.log(`${name} @ ${await c.getAddress()}`);
    return c;
  };
  const pinLib = await dep("PinLib");
  const polLib = await dep("PolicyLib");
  const openLib = await dep("OpenLib");
  const opsLib = await dep("OpsLib", { PolicyLib: await polLib.getAddress() });
  const libs = {
    PinLib: await pinLib.getAddress(),
    PolicyLib: await polLib.getAddress(),
    OpenLib: await openLib.getAddress(),
    OpsLib: await opsLib.getAddress(),
  };
  const impl = await dep("EncryptedAccount", libs, ENTRYPOINT_V08);
  const factory = await dep("EncryptedAccountFactory", undefined, await impl.getAddress());

  // Short delays for measurement (testnet demo only; production defaults are factory.defaultDelays()).
  const d = {
    pinTransfer: 0, bigTransfer: 60, genericCall: 60, settings: 60, loosen: 60, knownAdd: 60,
    recovery: 120, recoveryNoDevice: 300, pinReset: 300, escape: 300, escapeChange: 300,
  };
  const escapeAddr = hre.ethers.Wallet.createRandom().address;
  const salt = hre.ethers.id("e1-" + Date.now());
  const acctAddr = await factory.predictAddress(signer.address, escapeAddr, hre.ethers.ZeroAddress, d, salt);
  await (await factory.createAccountWithDelays(signer.address, escapeAddr, hre.ethers.ZeroAddress, d, salt)).wait();
  const acct: any = await hre.ethers.getContractAt("EncryptedAccount", acctAddr);
  console.log(`account @ ${acctAddr}`);

  // ── setup (real encrypted inputs, user = signer EOA)
  const tArgon0 = now();
  const fp = await pinFingerprint(PIN, chainId, acctAddr);
  const argonSetupMs = now() - tArgon0;
  let inp = hre.fhevm.createEncryptedInput(acctAddr, signer.address);
  inp.add64(fp);
  inp.add64(randomUint64());
  inp.addBool(false);
  let enc = await inp.encrypt();
  await (await acct.setupPin(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
  inp = hre.fhevm.createEncryptedInput(acctAddr, signer.address);
  inp.add64(100_000n); // 0.1 ETH (unit 1e12 wei)
  inp.add64(300_000n);
  inp.add64(3_000_000n);
  enc = await inp.encrypt();
  await (await acct.setupAsset(ETH, 10n ** 12n, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)).wait();
  const known = hre.ethers.Wallet.createRandom().address;
  const rList = [...Array(29).fill(hre.ethers.ZeroAddress), known];
  for (let s = 0; s < 30; s += 12) {
    inp = hre.fhevm.createEncryptedInput(acctAddr, signer.address);
    rList.slice(s, s + 12).forEach((a) => inp.addAddress(a));
    enc = await inp.encrypt();
    await (await acct.setupKnown(false, s, enc.handles, enc.inputProof)).wait();
  }
  inp = hre.fhevm.createEncryptedInput(acctAddr, signer.address);
  for (let i = 0; i < 10; i++) inp.addAddress(hre.ethers.ZeroAddress);
  enc = await inp.encrypt();
  await (await acct.setupKnown(true, 0, enc.handles, enc.inputProof)).wait();
  await (await acct.setupRoles(hre.ethers.ZeroAddress, hre.ethers.ZeroAddress, 90 * 86400, false)).wait();
  await (await acct.arm()).wait();
  await (await signer.sendTransaction({ to: acctAddr, value: hre.ethers.parseEther("0.01") })).wait();

  // ── E1: PIN flow
  const pinRuns: any[] = [];
  for (let i = 0; i < N; i++) {
    const to = hre.ethers.Wallet.createRandom().address;
    const rcOpen = await (await acct.requestTransfer(ETH, to, 1000n, true)).wait();
    const opId = await acct.opCount();
    const t0 = now();
    const fpi = await pinFingerprint(PIN, chainId, acctAddr); // the user enters the PIN every time
    const tArgon = now();
    const c = BigInt(await acct.challengeOf(opId));
    const gi = hre.fhevm.createEncryptedInput(acctAddr, signer.address);
    gi.add64(guessValue(fpi, c));
    const ge = await gi.encrypt();
    const tEnc = now();
    const rcGuess = await (await acct.submitGuess(opId, ge.handles[0], ge.inputProof)).wait();
    const tMined = now();
    const g = await acct.getGuess(opId);
    const hs = g.bigH === hre.ethers.ZeroHash ? [g.okH] : [g.okH, g.bigH];
    const { res, waitedMs } = await publicDecryptWithRetry(hs);
    const tDec = now();
    const rcFin = await (await acct.finalizeGuess(opId, res.abiEncodedClearValues, res.decryptionProof)).wait();
    const tEnd = now();
    const run = {
      i,
      opId: opId.toString(),
      argonMs: Math.round(tArgon - t0),
      encryptMs: Math.round(tEnc - tArgon),
      submitInclusionMs: Math.round(tMined - tEnc),
      publicDecryptMs: Math.round(tDec - tMined),
      publicDecryptPollMs: Math.round(waitedMs),
      finalizeInclusionMs: Math.round(tEnd - tDec),
      totalMs: Math.round(tEnd - t0),
      gas: { open: rcOpen!.gasUsed.toString(), submitGuess: rcGuess!.gasUsed.toString(), finalizeGuess: rcFin!.gasUsed.toString() },
      tx: { open: rcOpen!.hash, submitGuess: rcGuess!.hash, finalizeGuess: rcFin!.hash },
    };
    pinRuns.push(run);
    console.log(`PIN #${i}: total ${run.totalMs} ms (argon ${run.argonMs}, enc ${run.encryptMs}, mine ${run.submitInclusionMs}, decrypt ${run.publicDecryptMs}, fin ${run.finalizeInclusionMs})`);
  }

  // ── E1b: K-only evaluation (A2)
  const evalRuns: any[] = [];
  for (let i = 0; i < Math.min(N, 5); i++) {
    const t0 = now();
    const rc = await (await acct.requestTransfer(ETH, known, 1000n, false)).wait();
    const t1 = now();
    const opId = await acct.opCount();
    const op = await acct.getOp(opId);
    const { res } = await publicDecryptWithRetry([op.h0]);
    const t2 = now();
    const rcF = await (await acct.finalizeEvaluation(opId, res.abiEncodedClearValues, res.decryptionProof)).wait();
    const t3 = now();
    evalRuns.push({
      i,
      totalMs: Math.round(t3 - t0),
      inclusionMs: Math.round(t1 - t0),
      publicDecryptMs: Math.round(t2 - t1),
      finalizeMs: Math.round(t3 - t2),
      gas: { request: rc!.gasUsed.toString(), finalize: rcF!.gasUsed.toString() },
      tx: { request: rc!.hash, finalize: rcF!.hash },
    });
  }

  const totals = pinRuns.map((r) => r.totalMs);
  const out = {
    evidence: "[M] Sepolia",
    date: new Date().toISOString(),
    chainId: chainId.toString(),
    account: acctAddr,
    contracts: { ...libs, implementation: await impl.getAddress(), factory: await factory.getAddress() },
    argonSetupMs: Math.round(argonSetupMs),
    pin: { n: pinRuns.length, p50Ms: pct(totals, 50), p95Ms: pct(totals, 95), goNoGo: pct(totals, 95) < 60_000 ? "GO (p95 < 60 s)" : "NO-GO (p95 >= 60 s)", runs: pinRuns },
    kOnly: { n: evalRuns.length, p50Ms: pct(evalRuns.map((r) => r.totalMs), 50), p95Ms: pct(evalRuns.map((r) => r.totalMs), 95), runs: evalRuns },
  };
  const dir = path.join(__dirname, "..", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "e1-sepolia.json"), JSON.stringify(out, null, 2));
  console.log(`\nE1 PIN p50=${out.pin.p50Ms} ms p95=${out.pin.p95Ms} ms → ${out.pin.goNoGo}`);
  console.log(`A2 K-only p50=${out.kOnly.p50Ms} ms p95=${out.kOnly.p95Ms} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
