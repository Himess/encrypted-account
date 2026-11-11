/**
 * Hidden inheritance, W1, on Sepolia (demo periods): the acceptance run of the W1 package.
 *
 * 1. Deploys EncryptedWillDemoFactory (with its own EncryptedWill implementation) once; reuses the test ERC-7984 token.
 *    `WILL_DEPLOY_ONLY=1` stops here; `WILL_REDEPLOY=1` deploys a new factory (after a change to the will).
 * 2. Gives the f015b "e1" account (owner = the burner, test PIN, 60 s generic-call delay) a fresh will: inactivity and
 *    grace 300 s. Two heirs through the PIN path: slot 0 by claim code (60 %), slot 1 by address (40 %).
 * 3. After a real absence: start, settle, a payout round; a stranger claims; the address heir relays the code heir's
 *    claim to a fresh address X (only the code slot is paid there), claims by address to another address Y (no match:
 *    an address heir is paid only in a claim to itself), then to itself. A second deposit after the claims; a second
 *    round (two snapshot calls); a relayer claims with the code to X, the address heir again; each recipient decrypts
 *    its own balance.
 * 4. The cheapest proof of life on e1: openCall to the burner itself with no data, PIN guess, finalize.
 * 5. A separate account (created here, PIN set, escape address = a fresh in-memory wallet): its will is funded, the
 *    key starts the escape while the owner is alive, and anyone moves the will to the escape snapshot.
 *
 * Output: results/sepolia/will-w1.json (gas, HCU from executor events checked against HCULimit, decryptions).
 * Keys: the burner from .env.sepolia; every other wallet is created in memory, funded with a little Sepolia ETH and
 * swept back at the end. No key is written anywhere.
 *
 *   SEP_RUN=f015b npx hardhat run scripts/sepolia/will-w1-run.ts
 */
import { ethers } from "ethers";
import * as hre from "hardhat";
import * as path from "path";
import { guessValue, pinFingerprint, randomUint64 } from "../../sdk/src";
import { contractAt } from "../lib/deploy";
import { LiveCtx, OUT_DIR, encryptTimed, loadState, makeLiveCtx, publicDecryptWhenReady, saveState, writeJson } from "../lib/live";
import { eth, gwei, sleep } from "../lib/net";
import { CHAIN_ID, STATE_FILE, TEST_DELAYS, TEST_PIN, TxRec, ZERO32, escapeConsentSig, hcuOf, iso, now, parseEvent, send } from "./f09-lib";

const INACTIVITY = 300;
const GRACE = 300;
const WINDOW = 86_400;
const F1 = 1_000_000_007n;
const F2 = 500_000_003n;
const F3 = 777_000_000n;
const W1_STATE = path.join(OUT_DIR, "state-will-w1.json");
const V1_STATE = path.join(OUT_DIR, "state-will.json");
const FUND = ethers.parseEther("0.0012");

type Item = { tx: TxRec; receipt: ethers.TransactionReceipt };
const r = (x: number) => Math.round(x);
const log = (s: string) => console.log(`[${iso()}] ${s}`);

async function art(name: string) {
  const a = await hre.artifacts.readArtifact(name);
  return { abi: a.abi, bytecode: a.bytecode, deployedBytecode: a.deployedBytecode };
}

async function blockTime(ctx: LiveCtx): Promise<number> {
  return (await ctx.provider.getBlock("latest"))!.timestamp;
}

async function waitUntil(ctx: LiveCtx, t: number, what: string) {
  for (;;) {
    const bt = await blockTime(ctx);
    if (bt >= t) return bt;
    log(`waiting ${t - bt} s for ${what}`);
    await sleep(Math.min(30, t - bt + 3) * 1000);
  }
}

const random128 = () => {
  for (;;) {
    const v = BigInt(ethers.hexlify(ethers.randomBytes(16)));
    if (v !== 0n) return v;
  }
};

async function main() {
  const ctx = await makeLiveCtx();
  const user = ctx.user;
  const out: any = { startedAtUtc: iso(), network: "sepolia", periods: { inactivity: INACTIVITY, grace: GRACE, claimWindow: WINDOW }, txs: {} as Record<string, any> };
  const items: Record<string, Item> = {};
  const record = async (label: string, it: Item) => {
    items[label] = it;
    const hcu = await hcuOf(ctx.provider, it.receipt).catch(() => null);
    out.txs[label] = { hash: it.tx.hash, block: it.tx.blockNumber, gasUsed: Number(it.tx.gasUsed), hcu };
    log(`${label}: gas ${it.tx.gasUsed}${hcu ? `, HCU ${hcu.total} (depth ${hcu.depth}, meter ${hcu.meterCheck})` : ""}`);
    return it;
  };

  // ── 1. contracts
  const ws = loadState(W1_STATE);
  ws.contracts ??= {};
  ws.contracts.token ??= loadState(V1_STATE).contracts?.token;
  if (!ws.contracts.token) throw new Error("no test token in state-will.json");
  const A = { factory: await art("EncryptedWillDemoFactory"), will: await art("EncryptedWill"), token: await art("TestConfidentialToken") };
  if (process.env.WILL_REDEPLOY === "1" && ws.contracts.demoFactory) {
    (ws.previousDemoFactories ??= []).push({ factory: ws.contracts.demoFactory, implementation: ws.contracts.implementation });
    delete ws.contracts.demoFactory;
    delete ws.contracts.implementation;
  }
  if (!ws.contracts.demoFactory) {
    const f = new ethers.ContractFactory(A.factory.abi, A.factory.bytecode, user);
    const it = await send(user, "deploy demo factory", () => f.getDeployTransaction());
    ws.contracts.demoFactory = it.receipt.contractAddress;
    saveState(W1_STATE, ws);
    await record("deploy demo factory (+ implementation)", it);
  }
  const factory = new ethers.Contract(ws.contracts.demoFactory, A.factory.abi, user);
  ws.contracts.implementation = await factory.implementation();
  saveState(W1_STATE, ws);
  out.contracts = { ...ws.contracts };
  out.codeBytes = { will: (A.will.deployedBytecode.length - 2) / 2, demoFactory: (A.factory.deployedBytecode.length - 2) / 2 };
  log(`demo factory ${ws.contracts.demoFactory}, implementation ${ws.contracts.implementation}, token ${ws.contracts.token}`);
  if (process.env.WILL_DEPLOY_ONLY === "1") {
    writeJson("will-w1-deploy.json", out);
    return;
  }
  const token = new ethers.Contract(ws.contracts.token, A.token.abi, user);

  // ── 2. e1's will
  const st = loadState(STATE_FILE);
  const e1: string = st.accounts.e1.address;
  const acct = contractAt(ctx.build, "EncryptedAccount", e1, user);
  ws.runs = (ws.runs ?? 0) + 1;
  saveState(W1_STATE, ws);
  const window = WINDOW + ws.runs - 1;
  const willAddr: string = await factory.predictWill(e1, INACTIVITY, GRACE, window);
  await record("createWill", await send(user, "createWill", () => factory.createWill.populateTransaction(e1, INACTIVITY, GRACE, window)));
  const will = new ethers.Contract(willAddr, A.will.abi, user);
  out.will = { address: willAddr, account: e1, claimWindow: window };
  log(`will ${willAddr}`);

  const [relayer, heirB, stranger, recipientX, escapeE, recipientY] = Array.from({ length: 6 }, () => new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ctx.provider));
  out.wallets = { relayer: relayer.address, heirB: heirB.address, stranger: stranger.address, recipientX: recipientX.address, recipientY: recipientY.address, escapeE: escapeE.address };
  for (const w of [relayer, heirB, stranger]) await send(user, `fund ${w.address.slice(0, 8)}`, async () => ({ to: w.address, value: FUND }));

  const pinOp = async (label: string, target: string, data: string) => {
    const t0 = now();
    const open = await record(`${label}: openCall`, await send(user, `${label}: openCall`, () => acct.openCall.populateTransaction(target, 0, data)));
    const ev = parseEvent(acct, open.receipt, "OpOpened")!;
    const opId: bigint = ev.args.opId;
    const c = BigInt(ev.args.challenge);
    const fp = await pinFingerprint(TEST_PIN, CHAIN_ID, e1);
    const enc = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp, c) }], e1, user.address);
    const sub = await record(`${label}: submitGuess`, await send(user, `${label}: submitGuess`, () => acct.submitGuess.populateTransaction(opId, c, enc.handles[0], enc.inputProof)));
    const g = parseEvent(acct, sub.receipt, "GuessSubmitted")!;
    const hs = g.args.bigHandle === ZERO32 ? [g.args.okHandle] : [g.args.okHandle, g.args.bigHandle];
    const dec = await publicDecryptWhenReady(ctx, hs);
    const fin = await record(`${label}: finalizeGuess`, await send(user, `${label}: finalizeGuess`, () => acct.finalizeGuess.populateTransaction(opId, dec.abiEncodedClearValues, dec.decryptionProof)));
    if (!parseEvent(acct, fin.receipt, "GuessFinalized")?.args.ok) throw new Error(`${label}: PIN not accepted`);
    return { opId, ms: r(now() - t0) };
  };

  // heirs: slot 0 by code (60 %), slot 1 by address (40 %)
  const code = random128();
  const heirsEnc = await encryptTimed(
    ctx,
    [
      ...[ethers.ZeroAddress, heirB.address, ethers.ZeroAddress, ethers.ZeroAddress].map((v) => ({ type: "eaddress", value: v })),
      ...[code, 0n, 0n, 0n].map((v) => ({ type: "euint128", value: v })),
      ...[6000, 4000, 0, 0].map((v) => ({ type: "euint16", value: v })),
    ],
    willAddr,
    e1,
  );
  out.heirsEncrypt = heirsEnc.timing;
  const h = heirsEnc.handles;
  const set = await pinOp("setHeirs", willAddr, will.interface.encodeFunctionData("setHeirs", [h.slice(0, 4), h.slice(4, 8), h.slice(8, 12), heirsEnc.inputProof]));
  await waitUntil(ctx, Number((await acct.getOp(set.opId)).readyAt), "the generic-call delay");
  await record("setHeirs: executeOp", await send(user, "setHeirs: executeOp", () => acct.executeOp.populateTransaction(set.opId)));
  if (!(await will.heirsSet())) throw new Error("heirs not set");
  await record("mint F1", await send(user, "mint F1", () => token.mint.populateTransaction(willAddr, F1)));

  // absence → start → grace → settle
  await waitUntil(ctx, Number(await will.lastPinAt()) + INACTIVITY, "the absence");
  await record("start", await send(user, "start", () => will.start.populateTransaction()));
  await waitUntil(ctx, Number(await will.startedAt()) + GRACE, "the grace period");
  await record("settle", await send(user, "settle", () => will.settle.populateTransaction()));

  // round 1, in one snapshot call
  await record("round 1: prepare", await send(user, "round 1: prepare", () => will.prepare.populateTransaction(ws.contracts.token)));
  await record("round 1: snapshot 0–4", await send(user, "round 1: snapshot 0–4", () => will.snapshot.populateTransaction(ws.contracts.token, 0, 4)));

  const claim = async (label: string, w: ethers.Wallet, recipient: string, c: bigint | null) => {
    const mask = BigInt(await will.codeMask(recipient));
    const enc = await encryptTimed(ctx, [{ type: "euint128", value: (c ?? random128()) ^ mask }], willAddr, w.address);
    const wc = will.connect(w) as any;
    return await record(label, await send(w as any, label, () => wc.claim.populateTransaction(ws.contracts.token, recipient, enc.handles[0], enc.inputProof)));
  };
  await claim("claim 1: stranger → itself", stranger, stranger.address, null);
  await claim("claim 1: heir B relays the code claim → fresh address X", heirB, recipientX.address, code);
  await claim("claim 1: heir B, address → another address Y", heirB, recipientY.address, null);
  await claim("claim 1: heir B, address → itself", heirB, heirB.address, null);

  // money after the claims → round 2, in two snapshot calls
  await record("mint F2", await send(user, "mint F2", () => token.mint.populateTransaction(willAddr, F2)));
  await record("round 2: prepare", await send(user, "round 2: prepare", () => will.prepare.populateTransaction(ws.contracts.token)));
  await record("round 2: snapshot 0–2", await send(user, "round 2: snapshot 0–2", () => will.snapshot.populateTransaction(ws.contracts.token, 0, 2)));
  await record("round 2: snapshot 2–4", await send(user, "round 2: snapshot 2–4", () => will.snapshot.populateTransaction(ws.contracts.token, 2, 4)));
  await claim("claim 2: relayer, code → X", relayer, recipientX.address, code);
  await claim("claim 2: heir B, address → itself", heirB, heirB.address, null);

  // ── 4. the cheapest proof of life
  const alive = await pinOp("proof of life", user.address, "0x");
  out.proofOfLife = {
    gas: ["openCall", "submitGuess", "finalizeGuess"].reduce((s, k) => s + Number(items[`proof of life: ${k}`].tx.gasUsed), 0),
    ms: alive.ms,
  };

  // ── 5. a separate account: the escape while alive
  const factoryAcct = contractAt(ctx.build, "EncryptedAccountFactory", st.contracts.EncryptedAccountFactory, user);
  const guardian = ethers.Wallet.createRandom().address;
  const delays = { ...TEST_DELAYS };
  const salt = ethers.id(`will-w1-escape-${Date.now()}`);
  const acct2Addr: string = await factoryAcct.predictAddress(user.address, escapeE.address, guardian, delays, salt);
  const sig = await escapeConsentSig(escapeE, acct2Addr, 0);
  await record("escape account: createAccount", await send(user, "escape account: createAccount", () => factoryAcct.createAccountWithDelays.populateTransaction(user.address, escapeE.address, guardian, delays, salt, sig)));
  const acct2 = contractAt(ctx.build, "EncryptedAccount", acct2Addr, user);
  const fp2 = await pinFingerprint(TEST_PIN, CHAIN_ID, acct2Addr);
  const pinEnc = await encryptTimed(ctx, [{ type: "euint64", value: fp2 }, { type: "euint64", value: randomUint64() }, { type: "ebool", value: false }], acct2Addr, user.address);
  await record("escape account: setupPin", await send(user, "escape account: setupPin", () => acct2.setupPin.populateTransaction(pinEnc.handles[0], pinEnc.handles[1], pinEnc.handles[2], pinEnc.inputProof)));
  const will2Addr: string = await factory.predictWill(acct2Addr, INACTIVITY, GRACE, WINDOW);
  await record("escape account: createWill", await send(user, "escape account: createWill", () => factory.createWill.populateTransaction(acct2Addr, INACTIVITY, GRACE, WINDOW)));
  const will2 = new ethers.Contract(will2Addr, A.will.abi, user);
  await record("escape account: mint F3", await send(user, "escape account: mint F3", () => token.mint.populateTransaction(will2Addr, F3)));
  await record("escape account: startEscape", await send(user, "escape account: startEscape", () => acct2.startEscape.populateTransaction()));
  const w2s = will2.connect(stranger) as any;
  await record("escapeWithdraw (by a stranger)", await send(stranger as any, "escapeWithdraw", () => w2s.escapeWithdraw.populateTransaction(ws.contracts.token)));
  out.escapeAccount = { account: acct2Addr, will: will2Addr, escape: escapeE.address };

  // ── decryptions by each recipient
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk: any = require("@fhevm/sdk/ethers");
    if (typeof sdk.initFhevmDecryptRuntime === "function") await sdk.initFhevmDecryptRuntime();
  } catch (e: any) {
    log(`decrypt runtime: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  // What the contract pays: each round splits delta = balance − unpaid as q·s + ⌊r·s / 10000⌋ (q, r = delta ÷ 10000),
  // so the dust round 1 leaves (F1 minus what it paid) is part of round 2's delta.
  const pay = (delta: bigint, bps: bigint) => (delta / 10000n) * bps + ((delta % 10000n) * bps) / 10000n;
  const delta2 = F2 + (F1 - pay(F1, 6000n) - pay(F1, 4000n));
  const expected: Record<string, [ethers.Wallet, bigint]> = {
    recipientX: [recipientX, pay(F1, 6000n) + pay(delta2, 6000n)],
    heirB: [heirB, pay(F1, 4000n) + pay(delta2, 4000n)],
    recipientY: [recipientY, 0n],
    stranger: [stranger, 0n],
    escapeE: [escapeE, F3],
  };
  out.decrypted = {};
  for (const [k, [w, want]] of Object.entries(expected)) {
    try {
      const handle: string = await token.confidentialBalanceOf(w.address);
      const kp = await ctx.client.generateTransportKeyPair();
      const permit = await ctx.client.signDecryptionPermit({
        contractAddresses: [ws.contracts.token],
        startTimestamp: Math.floor(Date.now() / 1000) - 60,
        durationSeconds: 86400, // whole days only
        signerAddress: w.address,
        signer: w,
        transportKeyPair: kp,
      });
      if (handle === ZERO32) {
        out.decrypted[k] = { value: "0", expected: want.toString(), ok: want === 0n, note: "no balance handle: never received the token" };
        log(`${k}: ${JSON.stringify(out.decrypted[k])}`);
        continue;
      }
      let vals: any[] = [];
      for (let attempt = 1; ; attempt++) {
        try {
          vals = await ctx.client.decryptValues({ encryptedValues: [handle], contractAddress: ws.contracts.token, transportKeyPair: kp, signedPermit: permit });
          break;
        } catch (e: any) {
          // the relayer may not have seen the block that granted the balance yet
          if (attempt >= 10 || !/not authorized/i.test(String(e?.message ?? e))) throw e;
          await sleep(5000);
        }
      }
      const v = BigInt((vals[0] as any)?.value ?? vals[0]);
      out.decrypted[k] = { value: v.toString(), expected: want.toString(), ok: v === want };
    } catch (e: any) {
      out.decrypted[k] = { error: String(e?.message ?? e).slice(0, 200) };
    }
    log(`${k}: ${JSON.stringify(out.decrypted[k])}`);
  }

  // Gas per claim, and its execution part (without the 21,000 base and the calldata, whose zero bytes vary with the
  // random handle): equal operations should show equal execution gas, except for the first claim after a snapshot.
  out.claimGas = {};
  for (const label of Object.keys(items).filter((l) => l.startsWith("claim "))) {
    const tx = await ctx.provider.getTransaction(items[label].tx.hash);
    const d = ethers.getBytes(tx!.data);
    const zeros = d.filter((b) => b === 0).length;
    const calldata = (d.length - zeros) * 16 + zeros * 4;
    const gas = Number(items[label].tx.gasUsed);
    out.claimGas[label] = { gas, calldataGas: calldata, executionGas: gas - 21_000 - calldata };
  }

  // sweep the in-memory wallets back to the burner
  const fee = await ctx.provider.getFeeData();
  const price = (fee.maxFeePerGas ?? fee.gasPrice ?? 1n) * 2n;
  for (const w of [relayer, heirB, stranger]) {
    const bal = await ctx.provider.getBalance(w.address);
    if (bal > 21_000n * price) {
      try {
        await (await w.sendTransaction({ to: user.address, value: bal - 21_000n * price, gasLimit: 21_000n, maxFeePerGas: price, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? price })).wait();
      } catch (e: any) {
        log(`sweep ${w.address.slice(0, 8)} failed: ${String(e?.message).slice(0, 100)}`);
      }
    }
  }
  out.gasPriceGwei = gwei(fee.gasPrice ?? 0n);
  out.finishedAtUtc = iso();
  out.burnerBalanceEth = eth(await ctx.provider.getBalance(user.address));
  writeJson("will-w1.json", out);
  log("done → results/sepolia/will-w1.json");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
