/**
 * SPIKE (private mode) on Sepolia — T1 and T2 timing, N = 5 each, on a fresh EncryptedAccountP account that holds Zama's
 * official cUSDC (Mock) wrapper from the Wrappers Registry. Nothing here touches the F0.16 factory, its accounts or the
 * site: the F0.16 libraries PinLib / PolicyLib / OpenLib are reused as they are (stateless, unchanged code); OpsLib (with
 * the private-op hook), PrivateModule, EncryptedAccountP and a factory for it are new.
 *
 * T3 check on the production executor: on the mock, gas depends on secret values because its cleartext layer stores every
 * plaintext result; the Sepolia executor has no such layer. So this test account HAS a duress PIN (the product default is
 * still "no duress PIN"), and every real-PIN view of T2 is paired with a duress-PIN view, plus 3 pairs of PIN-gated
 * transfers; the pairs are compared transaction by transaction (execution gas, HCU, events, ACL grants).
 *
 *   npx hardhat compile
 *   SPIKE_STEP=check   npx hardhat run scripts/spike/sepolia-private.ts   → balances, fee, registry lookup, cost estimate
 *   SPIKE_STEP=all     npx hardhat run scripts/spike/sepolia-private.ts   → deploy, account, fund, T1 × 5, T2 × 5, refund
 *
 * Resumable (results/spike/sepolia/state.json). Output: results/spike/sepolia/private-mode-sepolia.json. The key is read
 * only from .env.sepolia and never printed: addresses, hashes, gas and times only.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { guessValue, pinFingerprint, randomUint64 } from "../../sdk/src";
import { Build, contractAt, deployFromBuild } from "../lib/deploy";
import { ROOT, hasWatchtowerKey, readEnvSepolia, sepoliaWatchtowerKey } from "../lib/env";
import { makeFhevmClient } from "../lib/fhevm";
import { LiveCtx, encryptTimed, patchFetch, publicDecryptWhenReady, withFetchLabel } from "../lib/live";
import { ENTRYPOINT_V08, ManagedWallet, eth, gwei, makeProvider, makeSigner, probeRpcs, sleep } from "../lib/net";
import { TEST_DELAYS, TEST_PIN, escapeConsentSig, hcuOf, pct, readAt, requireBalance, send } from "../sepolia/f09-lib";

const OUT = path.join(ROOT, "results", "spike", "sepolia");
const STATE = path.join(OUT, "state.json");
const N = Number(process.env.SPIKE_N ?? 5);
const STEP = process.env.SPIKE_STEP ?? "check";

// F0.16 deployment (results/sepolia/state-f016.json): stateless libraries, reused unchanged
const F016_LIBS = {
  PinLib: "0xe9eFae2f9C11cF7319a7eca23847ff5C99E197FB",
  PolicyLib: "0x8029e4f3bdD913b0Ab35e8DBF6B7b8c7B16dDA75",
  OpenLib: "0xA72C37Ee7305A2c79b57e3d5456b9C3804366c15",
};
// Zama Wrappers Registry and the official cUSDC (Mock) wrapper on Sepolia (docs.zama.org, addresses/testnet/sepolia)
const REGISTRY = "0x2f0750Bbb0A246059d80e94c454586a7F27a128e";
const USDC_MOCK = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";

const usd = (x: number) => BigInt(Math.round(x * 1e6)); // the wrapper keeps 6 decimals
const LIMITS = { lmin: usd(300), lmax: usd(1000), big: usd(10_000) };
const FUND = usd(10_000);
const T1_AMOUNT = usd(10);
const DURESS_PIN = "771203";
const DECOY = usd(2000);
const T3_TRANSFERS = [usd(100), usd(1500), usd(3000)];

/** Comparable shape of a live transaction: execution gas (gas minus calldata), HCU, events and ACL grants by role. */
function shapeOf(rc: ethers.TransactionReceipt, data: string, hcu: any, roles: Record<string, string>) {
  const b = ethers.getBytes(data);
  const zeros = b.filter((x) => x === 0).length;
  const intrinsic = 21000 + 4 * zeros + 16 * (b.length - zeros);
  const role = (a: string) => roles[a.toLowerCase()] ?? a.toLowerCase();
  const topic = (t: string) => {
    const v = BigInt(t);
    if (v < 1n << 160n) {
      const a = "0x" + v.toString(16).padStart(40, "0");
      if (roles[a]) return roles[a];
    }
    return "x";
  };
  const ALLOWED = ethers.id("Allowed(address,address,bytes32)");
  return {
    gasUsed: Number(rc.gasUsed),
    calldataLen: b.length,
    zeroBytes: zeros,
    exec: Number(rc.gasUsed) - intrinsic,
    hcu: hcu?.total ?? null,
    hcuDepth: hcu?.depth ?? null,
    logs: rc.logs.map((l) => [role(l.address), l.topics[0], l.topics.length, (l.data.length - 2) / 2, ...l.topics.slice(1).map(topic)].join("|")),
    aclAllowed: rc.logs.filter((l) => l.topics[0] === ALLOWED).map((l) => topic(l.topics[2])),
  };
}
const SHAPE_STRICT = ["exec", "hcu", "hcuDepth", "calldataLen", "logs", "aclAllowed"] as const;

type St = Record<string, any>;
const load = (): St => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
const save = (s: St) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
};

/** Build snapshot of the spike contracts from the compiled artifacts (kept with the results, like the F0.x runs). */
async function snapshot(): Promise<Build> {
  const file = path.join(OUT, "build.json");
  const contracts: Build["contracts"] = {};
  for (const n of ["OpsLib", "PrivateModule", "EncryptedAccountP", "EncryptedAccountFactory"]) {
    const a = await hre.artifacts.readArtifact(n);
    contracts[n] = { abi: a.abi as any[], bytecode: a.bytecode, linkReferences: a.linkReferences, deployedBytecodeBytes: (a.deployedBytecode.length - 2) / 2 };
  }
  // the account as callers see it: its own ABI, the module's functions, every library event and error
  const seen = new Set<string>();
  const abi: any[] = [];
  for (const n of ["EncryptedAccountP", "PrivateModule", "PinLib", "PolicyLib", "OpsLib", "OpenLib"]) {
    for (const f of (await hre.artifacts.readArtifact(n)).abi as any[]) {
      if (f.type === "constructor" || f.type === "fallback" || f.type === "receive") continue;
      if (n.endsWith("Lib") && f.type === "function") continue;
      const k = `${f.type}:${f.name}(${(f.inputs ?? []).map((i: any) => i.type).join(",")})`;
      if (!seen.has(k)) {
        seen.add(k);
        abi.push(f);
      }
    }
  }
  contracts.AccountP = { abi, bytecode: "0x", linkReferences: {}, deployedBytecodeBytes: 0 };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ contracts }, null, 1));
  return { contracts };
}

/** User decryption through Zama's relayer + KMS, timed. Retries "not authorized" while the relayer catches up. */
async function userDecryptTimed(ctx: LiveCtx, signer: ethers.Wallet, handle: string, contractAddress: string, expectDenied = false) {
  const c: any = ctx.client;
  const t0 = performance.now();
  const transportKeyPair = await c.generateTransportKeyPair();
  const signedPermit = await c.signDecryptionPermit({
    contractAddresses: [contractAddress],
    startTimestamp: Math.floor(Date.now() / 1000) - 60,
    durationSeconds: 86400,
    signerAddress: signer.address,
    signer,
    transportKeyPair,
  });
  const permitMs = Math.round(performance.now() - t0);
  for (let attempt = 1; ; attempt++) {
    try {
      const { value } = await withFetchLabel("userDecrypt", () => c.decryptValues({ encryptedValues: [handle], contractAddress, transportKeyPair, signedPermit }));
      const v: any = (value as any[])[0];
      const raw = String(v && typeof v === "object" && "value" in v ? v.value : v);
      const parsed = raw === "true" ? 1n : raw === "false" ? 0n : BigInt(raw);
      return { value: parsed as bigint | null, ms: Math.round(performance.now() - t0), permitMs, attempts: attempt, denied: false, error: null as string | null };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      const notAuth = /not authorized|unauthorized|not allowed|acl/i.test(msg);
      // only an ACL refusal counts as "denied"; anything else is a failure of the measurement itself
      if (notAuth && expectDenied) return { value: null, ms: Math.round(performance.now() - t0), permitMs, attempts: attempt, denied: true, error: msg };
      if (notAuth && attempt < 6) {
        await sleep(5000); // the relayer may not have seen the block that granted access yet
        continue;
      }
      throw new Error(`userDecrypt failed (${expectDenied ? "expected an ACL refusal" : "expected a value"}): ${msg}`);
    }
  }
}

async function main() {
  patchFetch();
  const provider = makeProvider();
  await probeRpcs(provider);
  const user = makeSigner(provider);
  const env = readEnvSepolia();
  if (!hasWatchtowerKey(env)) throw new Error("no watchtower key (the guardian of the spike account)");
  const guardian = new ManagedWallet(sepoliaWatchtowerKey(env), provider);
  const st = load();
  const build = await snapshot();
  const fee = await provider.getFeeData();
  const bal = await provider.getBalance(user.address);
  const log = (s: string) => console.log(s);
  log(`burner ${user.address} · ${eth(bal)} ETH · guardian ${guardian.address} · gas price ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei`);

  const registry = new ethers.Contract(REGISTRY, ["function getConfidentialTokenAddress(address) view returns (bool, address)", "function isConfidentialTokenValid(address) view returns (bool)"], provider);
  const [regValid, regWrapper] = await registry.getConfidentialTokenAddress(USDC_MOCK);
  const wrapper = new ethers.Contract(
    CUSDC,
    ["function rate() view returns (uint256)", "function decimals() view returns (uint8)", "function underlying() view returns (address)", "function wrap(address,uint256)", "function confidentialBalanceOf(address) view returns (bytes32)"],
    user,
  );
  const usdc = new ethers.Contract(USDC_MOCK, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"], user);
  const reg = { registry: REGISTRY, underlying: USDC_MOCK, wrapper: regWrapper, valid: regValid, matches: String(regWrapper).toLowerCase() === CUSDC.toLowerCase(), rate: String(await wrapper.rate()), wrapperDecimals: Number(await wrapper.decimals()), underlyingDecimals: Number(await usdc.decimals()) };
  log(`registry: USDC mock → ${regWrapper} (valid ${regValid}, our wrapper ${reg.matches}) · rate ${reg.rate} · decimals ${reg.underlyingDecimals}→${reg.wrapperDecimals}`);
  if (!reg.valid || !reg.matches) throw new Error("the registry does not list this wrapper as valid");
  st.registry = reg;

  // Gas still needed, from what the state file says is done. Sepolia prices code deposit at ≈1,560 gas per byte: the four
  // deployments cost ≈73M, the account setup ≈18M (measured in the first part of this run).
  const BOND = ethers.parseEther("0.001");
  const PER = { t1: 2_200_000n, view: 2_400_000n, transfer: 3_300_000n, refund: 60_000n };
  const left = (n: number) => BigInt(Math.max(0, n));
  const setupGas = st.account?.setup?.wrapToAccount ? 0n : 95_000_000n;
  const coreGas =
    setupGas + left(N - (st.t1?.length ?? 0)) * PER.t1 + left(N - (st.t2?.length ?? 0)) * (PER.view + PER.refund) + left(N - (st.t3views?.length ?? 0)) * (PER.view + PER.refund);
  const transferGas = left(2 * T3_TRANSFERS.length - (st.t3transfers?.length ?? 0)) * (PER.transfer + PER.refund);
  log(`still needed: core (setup, T1, T2, T3 views) ${coreGas} gas ≈ ${eth(coreGas * fee.gasPrice!)} ETH · T3 transfers ${transferGas} gas ≈ ${eth(transferGas * fee.gasPrice!)} ETH · plus one refundable bond ${eth(BOND)} ETH`);
  if (STEP === "check") {
    save(st);
    return;
  }
  // a bond still credited in the account (a refund that did not go through) comes back first
  if (st.account?.address) {
    const a0 = contractAt(build, "AccountP", st.account.address, user);
    const owed: bigint = await a0.refundOf(user.address);
    if (owed > 0n) {
      await send(user, "claimRefund (pending)", () => a0.claimRefund.populateTransaction(), { gasLimit: 150_000n });
      st.refunded = String(BigInt(st.refunded ?? "0") + owed);
      save(st);
      log(`  pending refund claimed: ${eth(owed)} ETH`);
    }
  }
  await requireBalance(provider, user, coreGas, "spike private mode (setup, T1, T2, T3 views)", BOND);

  // ── deploy
  st.contracts ??= {};
  st.deploys ??= {};
  const has = async (n: string) => Boolean(st.contracts[n]) && (await provider.getCode(st.contracts[n])).length > 2;
  const deploy = async (n: string, args: unknown[], libs: Record<string, string>) => {
    if (await has(n)) return;
    const d = await deployFromBuild(user, build, n, args, libs);
    st.contracts[n] = d.address;
    st.deploys[n] = { ...d.tx, runtimeBytes: d.runtimeBytes };
    save(st);
    log(`  ${n} @ ${d.address} · ${d.runtimeBytes} B · gas ${d.tx.gasUsed} · ${d.tx.hash}`);
  };
  await deploy("OpsLib", [], { PolicyLib: F016_LIBS.PolicyLib });
  await deploy("PrivateModule", [ENTRYPOINT_V08], { OpenLib: F016_LIBS.OpenLib });
  await deploy("EncryptedAccountP", [ENTRYPOINT_V08, ethers.ZeroAddress, st.contracts.PrivateModule], { ...F016_LIBS, OpsLib: st.contracts.OpsLib });
  await deploy("EncryptedAccountFactory", [st.contracts.EncryptedAccountP], {});
  const factory = contractAt(build, "EncryptedAccountFactory", st.contracts.EncryptedAccountFactory, user);

  // ── account (duress off: the duress slot takes FHE randomness, the decoy cap is a random value)
  if (!st.account) {
    const escape = ethers.Wallet.createRandom(); // E_addr: an ephemeral wallet, used once for its consent (K55)
    const salt = ethers.id(`spike-private-${Date.now()}`);
    const address: string = await factory.predictAddress(user.address, escape.address, guardian.address, TEST_DELAYS, salt);
    const sig = await escapeConsentSig(escape as unknown as ethers.Wallet, address, 0);
    st.account = { address, salt, escape: escape.address, guardian: guardian.address, delays: TEST_DELAYS, setup: {} };
    save(st);
    const r = await send(user, "createAccount", () => factory.createAccountWithDelays.populateTransaction(user.address, escape.address, guardian.address, TEST_DELAYS, salt, sig));
    st.account.setup.createAccount = { ...r.tx, hcu: await hcuOf(provider, r.receipt) };
    save(st);
    log(`  account ${address} · gas ${r.tx.gasUsed}`);
  }
  const addr: string = st.account.address;
  const acct = contractAt(build, "AccountP", addr, user);
  const step = async (label: string, run: () => Promise<{ tx: any; receipt: ethers.TransactionReceipt; encrypt?: any }>) => {
    if (st.account.setup[label]) return;
    const r = await run();
    st.account.setup[label] = { ...r.tx, hcu: await hcuOf(provider, r.receipt), ...(r.encrypt ? { encrypt: r.encrypt } : {}) };
    save(st);
    log(`  ${label}: gas ${r.tx.gasUsed} · HCU ${st.account.setup[label].hcu?.total ?? "-"} · ${r.tx.wallMs} ms`);
  };
  const enc = async (values: { type: string; value: any }[]) =>
    encryptTimed({ provider, user, watchtower: guardian, client: await makeFhevmClient(provider), build, clientReadyMs: 0 } as LiveCtx, values, addr, user.address);
  await step("setupPin", async () => {
    const fp = await pinFingerprint(TEST_PIN, 11155111n, addr);
    const dfp = await pinFingerprint(DURESS_PIN, 11155111n, addr); // test account only: it needs a duress PIN for T3
    const e = await enc([
      { type: "euint64", value: fp },
      { type: "euint64", value: dfp },
      { type: "ebool", value: true },
    ]);
    return { ...(await send(user, "setupPin", () => acct.setupPin.populateTransaction(e.handles[0], e.handles[1], e.handles[2], e.inputProof))), encrypt: e.timing };
  });
  await step("setupAsset", async () => {
    const e = await enc([
      { type: "euint64", value: LIMITS.lmin },
      { type: "euint64", value: LIMITS.lmax },
      { type: "euint64", value: LIMITS.big },
    ]);
    return { ...(await send(user, "setupAsset cUSDC", () => acct.setupAsset.populateTransaction(CUSDC, 1, e.handles[0], e.handles[1], e.handles[2], e.inputProof))), encrypt: e.timing };
  });
  await step("privateSetupAsset", async () => {
    const e = await enc([{ type: "euint64", value: DECOY }]);
    return { ...(await send(user, "privateSetupAsset", () => acct.privateSetupAsset.populateTransaction(CUSDC, e.handles[0], e.inputProof))), encrypt: e.timing };
  });
  const knownR = [...Array(29).fill(ethers.ZeroAddress), user.address]; // the owner's own wallet is the known recipient
  for (let s0 = 0; s0 < 30; s0 += 12) {
    const chunk = knownR.slice(s0, s0 + 12);
    await step(`setupKnownR${s0}`, async () => {
      const e = await enc(chunk.map((v) => ({ type: "eaddress", value: v })));
      return { ...(await send(user, `setupKnown R${s0}`, () => acct.setupKnown.populateTransaction(false, s0, e.handles, e.inputProof))), encrypt: e.timing };
    });
  }
  await step("setupKnownS0", async () => {
    const e = await enc(Array(10).fill({ type: "eaddress", value: ethers.ZeroAddress }));
    return { ...(await send(user, "setupKnown S0", () => acct.setupKnown.populateTransaction(true, 0, e.handles, e.inputProof))), encrypt: e.timing };
  });
  await step("setupRoles", () => send(user, "setupRoles", () => acct.setupRoles.populateTransaction(ethers.ZeroAddress, ethers.ZeroAddress, 90 * 86400, true)));
  await step("arm", () => send(user, "arm", () => acct.arm.populateTransaction()));

  // ── funding with the official wrapper: mint the mock USDC, approve, wrap straight to the account
  await step("mintUsdc", () => send(user, "USDC mock mint", () => usdc.mint.populateTransaction(user.address, FUND)));
  await step("approveUsdc", () => send(user, "USDC approve", () => usdc.approve.populateTransaction(CUSDC, FUND)));
  await step("wrapToAccount", () => send(user, "cUSDC wrap → account", () => wrapper.wrap.populateTransaction(addr, FUND)));

  const ctx: LiveCtx = { provider, user, watchtower: guardian, client: await makeFhevmClient(provider), build, clientReadyMs: 0 };

  // ── negative checks on the real KMS: K alone cannot read the balance
  if (!st.kAloneBalance) {
    // pinned to the wrap's block: a lagging backend would return the empty handle of the state before it
    const balH: string = await readAt((o) => wrapper.confidentialBalanceOf(addr, o), Number(st.account.setup.wrapToAccount.blockNumber));
    if (balH === ethers.ZeroHash) throw new Error("the account holds no cUSDC handle after the wrap");
    const viaToken = await userDecryptTimed(ctx, user, balH, CUSDC, true);
    const viaAccount = await userDecryptTimed(ctx, user, balH, addr, true);
    st.kAloneBalance = { handle: balH, viaToken: { denied: viaToken.denied, error: viaToken.error }, viaAccount: { denied: viaAccount.denied, error: viaAccount.error } };
    save(st);
    log(`  K alone decrypts the balance? via token: ${viaToken.denied ? "denied" : "YES"} · via account: ${viaAccount.denied ? "denied" : "YES"}`);
  }

  // ── T1 × N: one-transaction K-only private transfer to the known recipient (the owner's wallet)
  st.t1 ??= [];
  while (st.t1.length < N) {
    const i = st.t1.length + 1;
    const t0 = performance.now();
    const e = await encryptTimed(ctx, [{ type: "euint64", value: T1_AMOUNT }], addr, user.address);
    const r = await send(user, `T1 #${i}`, () => acct.privateTransfer.populateTransaction(CUSDC, user.address, e.handles[0], e.inputProof));
    const totalMs = Math.round(performance.now() - t0);
    const decryptRequests = r.receipt.logs.filter((l) => l.topics[0] === ethers.id("AllowedForDecryption(address,bytes32[])")).length;
    const ps = await readAt<any>((o) => acct.privateState(CUSDC, o), r.receipt.blockNumber);
    // T4: the guardian (watchtower) learns whether it passed; K cannot
    const g = await userDecryptTimed(ctx, guardian, ps.lastPass, addr);
    const kTry = i === 1 ? await userDecryptTimed(ctx, user, ps.lastPass, addr, true) : null;
    st.t1.push({
      i,
      encrypt: e.timing,
      tx: { hash: r.tx.hash, gasUsed: r.tx.gasUsed, wallMs: r.tx.wallMs, inclusionMs: r.tx.inclusionMs, blocks: r.tx.blocksToInclusion },
      hcu: await hcuOf(provider, r.receipt),
      decryptRequests,
      totalMs,
      guardianPass: { value: g.value, ms: g.ms, attempts: g.attempts },
      ...(kTry ? { kReadsPass: { denied: kTry.denied, error: kTry.error } } : {}),
    });
    save(st);
    log(`  T1 #${i}: ${totalMs} ms (proof ${e.timing.totalMs} + tx ${r.tx.wallMs}) · gas ${r.tx.gasUsed} · guardian sees pass=${g.value} after ${g.ms} ms`);
  }

  // ── one PIN-gated op end to end: open, fingerprint + encrypted guess with the bond, public decryption, finalize (the op
  //    runs inside finalize: a view has no delay, and the test delays give a private transfer none either), user decrypt
  const roles: Record<string, string> = { [addr.toLowerCase()]: "ACCOUNT", [CUSDC.toLowerCase()]: "TOKEN", [user.address.toLowerCase()]: "K", [guardian.address.toLowerCase()]: "G" };
  const parse = (rc: ethers.TransactionReceipt, name: string) =>
    rc.logs
      .map((l) => {
        try {
          return acct.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((x: any) => x?.name === name);
  const pinFlow = async (label: string, pin: string, open: () => Promise<ethers.TransactionRequest>) => {
    const t0 = performance.now();
    const fpP = pinFingerprint(pin, 11155111n, addr).then((v) => ({ v, ms: Math.round(performance.now() - t0) }));
    const o = await send(user, `${label} open`, open);
    const ev = parse(o.receipt, "OpOpened");
    const opId: bigint = ev!.args.opId;
    const c: bigint = BigInt(ev!.args.challenge);
    const fp = await fpP;
    const e = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp.v, c) }], addr, user.address);
    const [required] = await readAt<any>((x) => acct.ownerBond(x), o.receipt.blockNumber);
    const g = await send(user, `${label} submitGuess`, () => acct.submitGuess.populateTransaction(opId, c, e.handles[0], e.inputProof, { value: required }));
    const gs = await readAt<any>((x) => acct.getGuess(opId, x), g.receipt.blockNumber);
    const d = await publicDecryptWhenReady(ctx, [gs.okH]);
    const f = await send(user, `${label} finalizeGuess`, () => acct.finalizeGuess.populateTransaction(opId, d.abiEncodedClearValues, d.decryptionProof));
    const ex = parse(f.receipt, "PrivateOpExecuted");
    if (!ex) throw new Error(`${label}: no PrivateOpExecuted (wrong PIN?)`);
    const doneMs = Math.round(performance.now() - t0);
    const [ho, hg, hf] = [await hcuOf(provider, o.receipt), await hcuOf(provider, g.receipt), await hcuOf(provider, f.receipt)];
    const txData = async (h: string) => (await provider.getTransaction(h))!.data;
    return {
      opId,
      block: f.receipt.blockNumber,
      result: String(ex.args.result),
      doneMs,
      fingerprintMs: fp.ms,
      encrypt: e.timing,
      open: { hash: o.tx.hash, gasUsed: o.tx.gasUsed, wallMs: o.tx.wallMs, shape: shapeOf(o.receipt, await txData(o.tx.hash), ho, roles) },
      guess: { hash: g.tx.hash, gasUsed: g.tx.gasUsed, wallMs: g.tx.wallMs, hcu: hg, shape: shapeOf(g.receipt, await txData(g.tx.hash), hg, roles) },
      publicDecrypt: { waitedMs: d.waitedMs, attempts: d.attempts },
      finalize: { hash: f.tx.hash, gasUsed: f.tx.gasUsed, wallMs: f.tx.wallMs, hcu: hf, shape: shapeOf(f.receipt, await txData(f.tx.hash), hf, roles) },
    };
  };
  const refundNow = async (block?: number) => {
    const r: bigint = block ? await readAt((x) => acct.refundOf(user.address, x), block) : await acct.refundOf(user.address);
    if (r === 0n) return 0n;
    // fixed gas: an estimate from a lagging backend sees no refund yet and is too low for the ETH transfer
    await send(user, "claimRefund", () => acct.claimRefund.populateTransaction(), { gasLimit: 150_000n });
    return r;
  };
  st.refunded ??= "0";
  const addRefund = (x: bigint) => {
    st.refunded = String(BigInt(st.refunded) + x);
  };

  // ── T2 × N (real PIN, timed) paired with T3 duress-PIN views
  st.t2 ??= [];
  st.t3views ??= [];
  const balAfterT1 = FUND - T1_AMOUNT * BigInt(N);
  while (st.t2.length < N || st.t3views.length < N) {
    const i = Math.min(st.t2.length, st.t3views.length) + 1;
    if (st.t2.length < i) {
      const t0 = performance.now();
      const r = await pinFlow(`T2 #${i}`, TEST_PIN, () => acct.openPrivateView.populateTransaction(CUSDC));
      const u = await userDecryptTimed(ctx, user, r.result, addr);
      st.t2.push({ i, ...r, userDecrypt: { ms: u.ms, permitMs: u.permitMs, attempts: u.attempts }, seen: u.value, expected: balAfterT1, correct: u.value === balAfterT1, totalMs: Math.round(performance.now() - t0) });
      addRefund(await refundNow(r.block));
      save(st);
      log(`  T2 #${i}: ${st.t2[i - 1].totalMs} ms · saw ${u.value} (expected ${balAfterT1}) · decrypt ${r.publicDecrypt.waitedMs} ms · user decrypt ${u.ms} ms`);
    }
    if (st.t3views.length < i) {
      const r = await pinFlow(`T3 view #${i} (duress)`, DURESS_PIN, () => acct.openPrivateView.populateTransaction(CUSDC));
      const u = await userDecryptTimed(ctx, user, r.result, addr);
      const exp = balAfterT1 < DECOY ? balAfterT1 : DECOY;
      st.t3views.push({ i, ...r, seen: u.value, expected: exp, correct: u.value === exp });
      addRefund(await refundNow(r.block));
      save(st);
      log(`  T3 view #${i} (duress): saw ${u.value} (decoy expected ${exp})`);
    }
  }

  // ── T3 transfers: 3 pairs of PIN-gated private transfers to the owner's wallet, real PIN then duress PIN. Only if the
  //    balance covers them (they were added to the brief's T1/T2 to check T3 on the production executor).
  st.t3transfers ??= [];
  let decoyLeft = DECOY;
  for (const r0 of st.t3transfers as any[]) if (r0.mode === "duress") decoyLeft -= BigInt(r0.moved ?? 0);
  {
    const pairsLeft = left(2 * T3_TRANSFERS.length - st.t3transfers.length);
    const need = (pairsLeft * (PER.transfer + PER.refund) * (await provider.getFeeData()).gasPrice! * 125n) / 100n + (pairsLeft > 0n ? BOND : 0n);
    const have = await provider.getBalance(user.address);
    if (have < need) {
      st.t3transfersSkipped = { balanceWei: String(have), neededWei: String(need), shortByWei: String(need - have) };
      save(st);
      log(`  T3 transfers skipped: balance ${eth(have)} ETH, needed ${eth(need)} ETH (short by ${eth(need - have)} ETH)`);
    } else {
      delete st.t3transfersSkipped;
    }
  }
  while (!st.t3transfersSkipped && st.t3transfers.length < 2 * T3_TRANSFERS.length) {
    const k = st.t3transfers.length;
    const amount = T3_TRANSFERS[Math.floor(k / 2)];
    const mode = k % 2 === 0 ? "real" : "duress";
    const e = await encryptTimed(ctx, [{ type: "euint64", value: amount }], addr, user.address);
    const r = await pinFlow(`T3 transfer ${k + 1} (${mode})`, mode === "real" ? TEST_PIN : DURESS_PIN, () => acct.openPrivateTransfer.populateTransaction(CUSDC, user.address, e.handles[0], e.inputProof));
    // the recipient (the owner's wallet) may read what it received
    const moved = (await userDecryptTimed(ctx, user, r.result, CUSDC)).value;
    const exp = mode === "real" ? amount : amount <= decoyLeft ? amount : 0n;
    if (mode === "duress") decoyLeft -= moved ?? 0n;
    st.t3transfers.push({ k: k + 1, mode, amount, ...r, moved, expected: exp, correct: moved === exp });
    addRefund(await refundNow(r.block));
    save(st);
    log(`  T3 transfer ${k + 1} (${mode}): ${amount} → moved ${moved} (expected ${exp})`);
  }

  // ── pairwise comparison (real vs duress) of every transaction
  const t3diff: { pair: string; tx: string; metric: string; real: any; duress: any }[] = [];
  const cmp = (pair: string, a: any, b: any) => {
    for (const tx of ["open", "guess", "finalize"]) {
      for (const m of SHAPE_STRICT) {
        if (JSON.stringify(a[tx].shape[m]) !== JSON.stringify(b[tx].shape[m])) t3diff.push({ pair, tx, metric: m, real: a[tx].shape[m], duress: b[tx].shape[m] });
      }
    }
  };
  for (let i = 0; i < N; i++) cmp(`view ${i + 1}`, st.t2[i], st.t3views[i]);
  let transferPairs = 0;
  for (let k = 0; k + 1 < st.t3transfers.length; k += 2, transferPairs++) cmp(`transfer ${k / 2 + 1}`, st.t3transfers[k], st.t3transfers[k + 1]);
  const viewPairs = Math.min(st.t2.length, st.t3views.length);
  st.t3compare = { viewPairs, transferPairs, txCompared: 3 * (viewPairs + transferPairs), differences: t3diff.length, list: t3diff.slice(0, 30), transfersSkipped: st.t3transfersSkipped ?? null };
  save(st);
  log(`  T3 on Sepolia: ${t3diff.length} differences in ${st.t3compare.txCompared} transaction pairs`);

  // ── whatever bond is still credited goes back to the burner
  if (!st.refund) {
    const left = await refundNow();
    addRefund(left);
    st.refund = { totalRefunded: st.refunded };
    save(st);
    log(`  refunded in total ${eth(BigInt(st.refunded))} ETH`);
  }

  // ── summary
  const s = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), min: Math.min(...xs), max: Math.max(...xs) });
  const t1 = st.t1 as any[];
  const t2 = st.t2 as any[];
  const summary = {
    generatedAt: new Date().toISOString(),
    evidence: "[M] Sepolia, official cUSDC (Mock) wrapper from the Zama Wrappers Registry",
    registry: st.registry,
    contracts: st.contracts,
    reusedF016Libraries: F016_LIBS,
    account: st.account.address,
    setupGas: Object.fromEntries(Object.entries(st.account.setup).map(([k, v]: any) => [k, Number(v.gasUsed)])),
    kAloneBalance: st.kAloneBalance,
    T1: {
      totalMs: s(t1.map((r) => r.totalMs)),
      inputProofMs: s(t1.map((r) => r.encrypt.totalMs)),
      txMs: s(t1.map((r) => r.tx.wallMs)),
      decryptionMs: "none (no decryption in the path)",
      gas: s(t1.map((r) => Number(r.tx.gasUsed))),
      hcu: s(t1.map((r) => r.hcu?.total ?? 0)),
      decryptRequests: t1.map((r) => r.decryptRequests),
      guardianLearnsPassMs: s(t1.map((r) => r.guardianPass.ms)),
      kReadsPassBit: t1[0]?.kReadsPass,
    },
    T2: {
      totalMs: s(t2.map((r) => r.totalMs)),
      fingerprintMs: s(t2.map((r) => r.fingerprintMs)),
      inputProofMs: s(t2.map((r) => r.encrypt.totalMs)),
      txMs: s(t2.map((r) => r.open.wallMs + r.guess.wallMs + r.finalize.wallMs)),
      publicDecryptMs: s(t2.map((r) => r.publicDecrypt.waitedMs)),
      userDecryptMs: s(t2.map((r) => r.userDecrypt.ms)),
      gasTotal: s(t2.map((r) => Number(r.open.gasUsed) + Number(r.guess.gasUsed) + Number(r.finalize.gasUsed))),
      allCorrect: t2.every((r) => r.correct),
    },
    T3: {
      note: "production executor: real-PIN vs duress-PIN transactions compared pair by pair (execution gas = gas minus calldata gas)",
      ...st.t3compare,
      viewsCorrect: (st.t3views as any[]).every((r) => r.correct),
      transfersCorrect: (st.t3transfers as any[]).every((r) => r.correct),
      totalGasPairs: [
        ...(st.t2 as any[]).map((r, i) => ({ pair: `view ${i + 1}`, real: [r.open.gasUsed, r.guess.gasUsed, r.finalize.gasUsed].map(Number), duress: [st.t3views[i].open.gasUsed, st.t3views[i].guess.gasUsed, st.t3views[i].finalize.gasUsed].map(Number) })),
        ...[0, 2, 4]
          .filter((k) => st.t3transfers[k + 1])
          .map((k) => ({ pair: `transfer ${k / 2 + 1}`, real: [st.t3transfers[k].open.gasUsed, st.t3transfers[k].guess.gasUsed, st.t3transfers[k].finalize.gasUsed].map(Number), duress: [st.t3transfers[k + 1].open.gasUsed, st.t3transfers[k + 1].guess.gasUsed, st.t3transfers[k + 1].finalize.gasUsed].map(Number) })),
      ],
    },
    refund: st.refund,
    runs: { t1, t2, t3views: st.t3views, t3transfers: st.t3transfers },
  };
  fs.writeFileSync(path.join(OUT, "private-mode-sepolia.json"), JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  log(`T1 total p50 ${summary.T1.totalMs.p50} ms · p95 ${summary.T1.totalMs.p95} ms | T2 total p50 ${summary.T2.totalMs.p50} ms · p95 ${summary.T2.totalMs.p95} ms`);
  log(`burner left ${eth(await provider.getBalance(user.address))} ETH`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.message ?? e).slice(0, 600));
    process.exit(1);
  });
