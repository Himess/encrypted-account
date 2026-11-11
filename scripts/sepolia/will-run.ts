/**
 * Hidden inheritance on Sepolia (EncryptedWill + a test ERC-7984 token).
 *
 * 1. Deploys TestConfidentialToken, the EncryptedWill implementation and EncryptedWillFactory (once; kept in the state).
 * 2. Creates a fresh will for the f015b "e1" account (owner = the burner, test PIN, 60 s generic-call delay), with a
 *    5-minute inactivity period and a 5-minute grace period (demo values; real wills use months).
 * 3. Sets two heirs (60 % / 40 %) through the account's PIN path: openCall → submitGuess → public decryption →
 *    finalizeGuess → 60 s → executeOp. Mints test tokens to the will.
 * 4. After 5 minutes without a PIN: start. Then a correct PIN on the account (an unrelated generic call) voids it:
 *    settle must revert (checked with eth_call).
 * 5. After a real absence (5 + 5 minutes without a PIN): start, settle. Then a stranger claims first (this fixes the
 *    amounts), both heirs claim, a second stranger claims, and the first heir claims again.
 * 6. Every claimant decrypts its own token balance with a user decryption (EIP-712 permit signed by its wallet).
 *
 * Gas, HCU (from executor events, cross-checked with HCULimit.getBlockMeter) and timings go to
 * results/sepolia/will-run.json. Keys: the burner from .env.sepolia; the four claimants are fresh in-memory wallets,
 * funded with a little Sepolia ETH and swept back at the end. No key is written anywhere.
 *
 *   SEP_RUN=f015b npx hardhat run scripts/sepolia/will-run.ts
 */
import { ethers } from "ethers";
import * as hre from "hardhat";
import * as path from "path";
import { guessValue, pinFingerprint } from "../../sdk/src";
import { contractAt } from "../lib/deploy";
import { LiveCtx, OUT_DIR, encryptTimed, loadState, makeLiveCtx, publicDecryptWhenReady, saveState, writeJson } from "../lib/live";
import { eth, gwei, sleep } from "../lib/net";
import { CHAIN_ID, STATE_FILE, TEST_PIN, TxRec, ZERO32, hcuOf, iso, now, parseEvent, send } from "./f09-lib";

const INACTIVITY = Number(process.env.WILL_INACTIVITY_S ?? 300);
const GRACE = Number(process.env.WILL_GRACE_S ?? 300);
const FUNDED = 1_000_000_007n; // test token base units (6 decimals): ≈ 1,000 tcUSD, odd so the floors show
const SHARES = [6000, 4000];
const CLAIMANT_FUNDING = ethers.parseEther("0.0008");
const WILL_STATE = path.join(OUT_DIR, "state-will.json");

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
    const left = t - bt;
    log(`waiting ${left} s for ${what}`);
    await sleep(Math.min(30, left + 3) * 1000);
  }
}

async function main() {
  const ctx = await makeLiveCtx();
  const user = ctx.user;
  const out: any = { startedAtUtc: iso(), network: "sepolia", inactivityS: INACTIVITY, graceS: GRACE, txs: {} as Record<string, any> };
  const items: Record<string, Item> = {};
  const record = async (label: string, it: Item) => {
    items[label] = it;
    const hcu = await hcuOf(ctx.provider, it.receipt).catch(() => null);
    out.txs[label] = { hash: it.tx.hash, block: it.tx.blockNumber, gasUsed: Number(it.tx.gasUsed), inclusionMs: it.tx.inclusionMs, hcu };
    log(`${label}: gas ${it.tx.gasUsed}${hcu ? `, HCU ${hcu.total} (depth ${hcu.depth}, meter ${hcu.meterCheck})` : ""}`);
  };

  const st = loadState(STATE_FILE);
  const acctAddr: string = st.accounts.e1.address;
  const acct = contractAt(ctx.build, "EncryptedAccount", acctAddr, user);
  const roles = await acct.roles();
  if (roles.owner_.toLowerCase() !== user.address.toLowerCase()) throw new Error("e1's owner is not the burner");
  const delays = await acct.delays();
  out.account = { address: acctAddr, genericCallDelayS: Number(delays.genericCall) };
  log(`account ${acctAddr}, generic-call delay ${delays.genericCall} s; burner balance ${eth(await ctx.provider.getBalance(user.address))} ETH`);

  // ── 1. contracts (once)
  const ws = loadState(WILL_STATE);
  ws.contracts ??= {};
  const A = {
    token: await art("TestConfidentialToken"),
    impl: await art("EncryptedWill"),
    factory: await art("EncryptedWillFactory"),
  };
  out.codeHashes = Object.fromEntries(Object.entries(A).map(([k, v]) => [k, ethers.keccak256(v.deployedBytecode)]));
  out.codeBytes = Object.fromEntries(Object.entries(A).map(([k, v]) => [k, (v.deployedBytecode.length - 2) / 2]));
  for (const [key, ctor] of [["token", []], ["impl", []]] as const) {
    if (ws.contracts[key]) continue;
    const f = new ethers.ContractFactory(A[key].abi, A[key].bytecode, user);
    const it = await send(user, `deploy ${key}`, () => f.getDeployTransaction(...ctor));
    ws.contracts[key] = it.receipt.contractAddress;
    saveState(WILL_STATE, ws);
    await record(`deploy ${key}`, it);
  }
  if (!ws.contracts.factory) {
    const f = new ethers.ContractFactory(A.factory.abi, A.factory.bytecode, user);
    const it = await send(user, "deploy factory", () => f.getDeployTransaction(ws.contracts.impl));
    ws.contracts.factory = it.receipt.contractAddress;
    saveState(WILL_STATE, ws);
    await record("deploy factory", it);
  }
  out.contracts = { ...ws.contracts };
  const token = new ethers.Contract(ws.contracts.token, A.token.abi, user);
  const factory = new ethers.Contract(ws.contracts.factory, A.factory.abi, user);

  // ── 2. a fresh will per run (the grace period carries the run number, so the address is new)
  ws.runs = (ws.runs ?? 0) + 1;
  saveState(WILL_STATE, ws);
  const grace = GRACE + ws.runs - 1;
  const willAddr: string = await factory.predictWill(acctAddr, INACTIVITY, grace);
  await record("createWill", await send(user, "createWill", () => factory.createWill.populateTransaction(acctAddr, INACTIVITY, grace)));
  const will = new ethers.Contract(willAddr, A.impl.abi, user);
  out.will = { address: willAddr, inactivityS: INACTIVITY, graceS: grace, run: ws.runs };
  log(`will ${willAddr}`);

  // claimants: fresh in-memory wallets (never written anywhere)
  const [heirA, heirB, strangerC, strangerD] = Array.from({ length: 4 }, () => ethers.Wallet.createRandom().connect(ctx.provider));
  out.claimants = { heirA: heirA.address, heirB: heirB.address, strangerC: strangerC.address, strangerD: strangerD.address };
  for (const w of [heirA, heirB, strangerC, strangerD]) {
    await send(user, `fund ${w.address.slice(0, 8)}`, async () => ({ to: w.address, value: CLAIMANT_FUNDING }));
  }

  // ── PIN path helper
  const pinOp = async (label: string, target: string, data: string) => {
    const t0 = now();
    const open = await send(user, `${label}: openCall`, () => acct.openCall.populateTransaction(target, 0, data));
    await record(`${label}: openCall`, open);
    const ev = parseEvent(acct, open.receipt, "OpOpened")!;
    const opId: bigint = ev.args.opId;
    const c = BigInt(ev.args.challenge);
    const fp = await pinFingerprint(TEST_PIN, CHAIN_ID, acctAddr);
    const enc = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp, c) }], acctAddr, user.address);
    const sub = await send(user, `${label}: submitGuess`, () => acct.submitGuess.populateTransaction(opId, c, enc.handles[0], enc.inputProof));
    await record(`${label}: submitGuess`, sub);
    const g = parseEvent(acct, sub.receipt, "GuessSubmitted")!;
    const hs = g.args.bigHandle === ZERO32 ? [g.args.okHandle] : [g.args.okHandle, g.args.bigHandle];
    const dec = await publicDecryptWhenReady(ctx, hs);
    const fin = await send(user, `${label}: finalizeGuess`, () => acct.finalizeGuess.populateTransaction(opId, dec.abiEncodedClearValues, dec.decryptionProof));
    await record(`${label}: finalizeGuess`, fin);
    const gf = parseEvent(acct, fin.receipt, "GuessFinalized");
    if (!gf?.args.ok) throw new Error(`${label}: the PIN was not accepted`);
    return { opId, pinMs: r(now() - t0) };
  };

  // ── 3. heirs through the PIN path
  const heirsEnc = await encryptTimed(
    ctx,
    [
      { type: "eaddress", value: heirA.address },
      { type: "eaddress", value: heirB.address },
      { type: "eaddress", value: ethers.ZeroAddress },
      { type: "eaddress", value: ethers.ZeroAddress },
      ...[...SHARES, 0, 0].map((v) => ({ type: "euint16", value: v })),
    ],
    willAddr,
    acctAddr, // the account is msg.sender at the will
  );
  out.heirsEncrypt = heirsEnc.timing;
  const setData = will.interface.encodeFunctionData("setHeirs", [heirsEnc.handles.slice(0, 4), heirsEnc.handles.slice(4), heirsEnc.inputProof]);
  const set = await pinOp("setHeirs", willAddr, setData);
  out.setHeirsPinMs = set.pinMs;
  const op = await acct.getOp(set.opId);
  await waitUntil(ctx, Number(op.readyAt), "the generic-call delay");
  await record("setHeirs: executeOp", await send(user, "setHeirs: executeOp", () => acct.executeOp.populateTransaction(set.opId)));
  if (!(await will.heirsSet())) throw new Error("heirs not set");

  await record("mint to will", await send(user, "mint to will", () => token.mint.populateTransaction(willAddr, FUNDED)));

  // ── 4. an absence starts it, a correct PIN voids it
  const pin1 = Number(await will.lastPinAt());
  out.lastPinAfterSetHeirs = pin1;
  await waitUntil(ctx, pin1 + INACTIVITY, "the inactivity period");
  await record("start #1", await send(user, "start #1", () => will.start.populateTransaction()));
  const start1 = Number(await will.startedAt());
  const harmless = token.interface.encodeFunctionData("name");
  await pinOp("proof of life", ws.contracts.token, harmless);
  const pin2 = Number(await will.lastPinAt());
  out.voidCheck = { startedAt: start1, lastPinAt: pin2, pinAfterStart: pin2 >= start1 };
  await waitUntil(ctx, start1 + grace, "the grace period of start #1");
  try {
    await will.settle.staticCall();
    out.voidCheck.settleReverted = false;
  } catch (e: any) {
    out.voidCheck.settleReverted = true;
    out.voidCheck.revert = will.interface.parseError(e?.data ?? e?.info?.error?.data ?? "0x")?.name ?? String(e?.shortMessage ?? e?.message).slice(0, 120);
  }
  log(`void check: ${JSON.stringify(out.voidCheck)}`);
  if (!out.voidCheck.settleReverted) throw new Error("a PIN during grace did not void the start");

  // ── 5. a real absence
  await waitUntil(ctx, pin2 + INACTIVITY, "a new inactivity period");
  await record("start #2", await send(user, "start #2", () => will.start.populateTransaction()));
  const start2 = Number(await will.startedAt());
  await waitUntil(ctx, start2 + grace, "the grace period");
  await record("settle", await send(user, "settle", () => will.settle.populateTransaction()));

  const claim = async (label: string, w: ethers.Wallet) => {
    const wc = will.connect(w) as any;
    await record(label, await send(w as any, label, () => wc.claim.populateTransaction(ws.contracts.token)));
  };
  await claim("claim: stranger C (first: fixes the amounts)", strangerC);
  await claim("claim: heir A", heirA);
  await claim("claim: heir B", heirB);
  await claim("claim: stranger D", strangerD);
  await claim("claim: heir A again", heirA);

  // ── 6. each claimant decrypts its own balance
  const expected: Record<string, bigint> = {
    heirA: (FUNDED * BigInt(SHARES[0])) / 10000n,
    heirB: (FUNDED * BigInt(SHARES[1])) / 10000n,
    strangerC: 0n,
    strangerD: 0n,
  };
  out.decrypted = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk: any = require("@fhevm/sdk/ethers");
    if (typeof sdk.initFhevmDecryptRuntime === "function") await sdk.initFhevmDecryptRuntime();
  } catch (e: any) {
    log(`decrypt runtime: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  for (const [k, w] of Object.entries({ heirA, heirB, strangerC, strangerD })) {
    try {
      const h: string = await token.confidentialBalanceOf(w.address);
      const kp = await ctx.client.generateTransportKeyPair();
      const permit = await ctx.client.signDecryptionPermit({
        contractAddresses: [ws.contracts.token],
        startTimestamp: Math.floor(Date.now() / 1000) - 60,
        durationSeconds: 86400, // the SDK accepts whole days only
        signerAddress: w.address,
        signer: w,
        transportKeyPair: kp,
      });
      const vals = await ctx.client.decryptValues({ encryptedValues: [h], contractAddress: ws.contracts.token, transportKeyPair: kp, signedPermit: permit });
      const v = BigInt((vals[0] as any)?.value ?? vals[0]);
      out.decrypted[k] = { value: v.toString(), expected: expected[k].toString(), ok: v === expected[k] };
    } catch (e: any) {
      out.decrypted[k] = { error: String(e?.message ?? e).slice(0, 200) };
    }
    log(`${k}: ${JSON.stringify(out.decrypted[k])}`);
  }

  // heir and stranger claims after the first one: same gas?
  out.claimGas = {
    heirB: Number(items["claim: heir B"].tx.gasUsed),
    strangerD: Number(items["claim: stranger D"].tx.gasUsed),
    heirAAgain: Number(items["claim: heir A again"].tx.gasUsed),
    first: Number(items["claim: stranger C (first: fixes the amounts)"].tx.gasUsed),
  };

  // ── sweep the claimants back to the burner
  const fee = await ctx.provider.getFeeData();
  const price = (fee.maxFeePerGas ?? fee.gasPrice ?? 1n) * 2n;
  for (const w of [heirA, heirB, strangerC, strangerD]) {
    const bal = await ctx.provider.getBalance(w.address);
    const cost = 21_000n * price;
    if (bal > cost) {
      try {
        const tx = await w.sendTransaction({ to: user.address, value: bal - cost, gasLimit: 21_000n, maxFeePerGas: price, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? price });
        await tx.wait();
      } catch (e: any) {
        log(`sweep ${w.address.slice(0, 8)} failed: ${String(e?.message).slice(0, 100)}`);
      }
    }
  }
  out.gasPriceGwei = gwei(fee.gasPrice ?? 0n);
  out.finishedAtUtc = iso();
  out.burnerBalanceEth = eth(await ctx.provider.getBalance(user.address));
  writeJson("will-run.json", out);
  log("done → results/sepolia/will-run.json");
}

main().then(
  () => process.exit(0), // the SDK keeps sockets open; the run is over
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
