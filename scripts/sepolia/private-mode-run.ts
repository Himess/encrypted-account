/**
 * Private mode (optional) on Sepolia, with the feature/private-mode contracts: T3 transfer pairs (real PIN vs duress PIN),
 * T1 (K-only private transfer) and T2 (PIN view), N = 5 each, plus the watchtower's wrong-PIN and duress checks.
 *
 * New addresses only: PrivateModule, EncryptedAccountP and an EncryptedAccountFactory for it. The F0.16 libraries (PinLib,
 * PolicyLib, OpenLib, OpsLib) are reused as they are: stateless, and the `check` step verifies that their on-chain code is
 * the code this branch compiles. Nothing here touches the F0.16 factory, its accounts or the site.
 *
 * A PIN-verified private transfer waits at least 72 hours (PrivateStorage.MIN_BIG_DELAY, a constant), so T3 has two halves:
 * `t3open` schedules the pairs now (open, guess, finalize), `t3exec` runs them once they are due (executeOp).
 *
 *   npx hardhat compile
 *   PSTEP=check    npx hardhat run scripts/sepolia/private-mode-run.ts   → balances, fee, library check, estimate
 *   PSTEP=setup    npx hardhat run scripts/sepolia/private-mode-run.ts   → deploy, account (guardian = watchtower), fund
 *   PSTEP=measure  npx hardhat run scripts/sepolia/private-mode-run.ts   → t3open, t1, t2, wrong PIN (watchtower running)
 *   PSTEP=t3exec   npx hardhat run scripts/sepolia/private-mode-run.ts   → the scheduled transfers, once due
 *   PSTEP=summary  npx hardhat run scripts/sepolia/private-mode-run.ts   → results/private-mode/sepolia/summary.json
 *
 * Resumable (results/private-mode/sepolia/state.json). The keys are read only from .env.sepolia and never printed:
 * addresses, hashes, gas and times only.
 */
import { ethers } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";
import * as path from "path";
import { guessValue, pinFingerprint } from "../../sdk/src";
import { Build, contractAt, deployFromBuild } from "../lib/deploy";
import { ROOT, hasWatchtowerKey, readEnvSepolia, sepoliaWatchtowerKey } from "../lib/env";
import { makeFhevmClient } from "../lib/fhevm";
import { LiveCtx, encryptTimed, patchFetch, publicDecryptWhenReady, withFetchLabel } from "../lib/live";
import { ENTRYPOINT_V08, ManagedWallet, eth, gwei, makeProvider, makeSigner, probeRpcs, sleep } from "../lib/net";
import { ETH_UNIT, LIMITS as ETH_LIMITS, TEST_DELAYS, TEST_PIN, escapeConsentSig, hcuOf, pct, readAt, send } from "./f09-lib";

const OUT = path.join(ROOT, "results", "private-mode", "sepolia");
const STATE = path.join(OUT, "state.json");
export const NOTICES = path.join(OUT, "watchtower-notices.jsonl");
const N = Number(process.env.PN ?? 5);
const STEP = process.env.PSTEP ?? "check";

// F0.16 deployment (results/sepolia/state-f016.json): stateless libraries, reused unchanged (checked in `check`)
const F016_LIBS = {
  PinLib: "0xe9eFae2f9C11cF7319a7eca23847ff5C99E197FB",
  PolicyLib: "0x8029e4f3bdD913b0Ab35e8DBF6B7b8c7B16dDA75",
  OpenLib: "0xA72C37Ee7305A2c79b57e3d5456b9C3804366c15",
  OpsLib: "0x537EC15E00fdf6e9Cb8d3BF5d0F46A06A09A7fA2",
};
// Zama Wrappers Registry and the official cUSDC (Mock) wrapper on Sepolia (as in the spike run)
const REGISTRY = "0x2f0750Bbb0A246059d80e94c454586a7F27a128e";
const USDC_MOCK = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";

const usd = (x: number) => BigInt(Math.round(x * 1e6)); // the wrapper keeps 6 decimals
const PRIVATE_LIMITS = { lmin: usd(300), lmax: usd(1000) };
const FUND = usd(10_000);
const T1_AMOUNT = usd(10);
const DURESS_PIN = "771203";
const WRONG_PIN = "000017";
const DECOY = usd(2000);
/** T3 pairs (real PIN, then duress PIN, same amount). Under duress: moves while it fits the decoy left, else zero. */
const T3_AMOUNTS = [usd(100), usd(500), usd(1500), usd(3000), usd(50), usd(1350)];
/** The product's delays for a private-mode account start at bigTransfer = 72 h; the rest are short test delays. */
const DELAYS_P = { ...TEST_DELAYS, bigTransfer: 72 * 3600 };

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

/** Build snapshot of the new contracts, plus the account's combined ABI (its own, the module's, every library event/error). */
async function snapshot(): Promise<Build> {
  const contracts: Build["contracts"] = {};
  for (const n of ["PrivateModule", "EncryptedAccountP", "EncryptedAccountFactory"]) {
    const a = await hre.artifacts.readArtifact(n);
    contracts[n] = { abi: a.abi as any[], bytecode: a.bytecode, linkReferences: a.linkReferences, deployedBytecodeBytes: (a.deployedBytecode.length - 2) / 2 };
  }
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
  fs.writeFileSync(path.join(OUT, "build.json"), JSON.stringify({ contracts }, null, 1));
  return { contracts };
}

/** Runtime code without the CBOR metadata tail. */
function stripMeta(hex: string): string {
  const b = hex.replace(/^0x/, "").toLowerCase();
  const len = parseInt(b.slice(-4), 16);
  return len > 0 && len * 2 + 4 < b.length ? b.slice(0, b.length - 4 - len * 2) : b;
}

/** Is the library at `addr` the code this branch compiles? (call-protection address and links normalised, metadata cut) */
async function libraryMatches(provider: ethers.Provider, name: string, addr: string, links: Record<string, string>) {
  const a = await hre.artifacts.readArtifact(name);
  let local = a.deployedBytecode.replace(/^0x/, "").toLowerCase();
  for (const file of Object.keys(a.deployedLinkReferences ?? {})) {
    for (const lib of Object.keys((a.deployedLinkReferences as any)[file])) {
      for (const { start, length } of (a.deployedLinkReferences as any)[file][lib]) {
        local = local.slice(0, start * 2) + links[lib].toLowerCase().replace(/^0x/, "") + local.slice((start + length) * 2);
      }
    }
  }
  // a library's runtime code holds PUSH20 <its own address> (call protection), zero in the compiled code
  const own = addr.toLowerCase().replace(/^0x/, "");
  const chain = (await provider.getCode(addr)).replace(/^0x/, "").toLowerCase().split(own).join("0".repeat(40));
  return stripMeta("0x" + local) === stripMeta("0x" + chain);
}

/** User decryption through Zama's relayer + KMS, timed. Retries "not authorized" while the relayer catches up. */
async function userDecryptTimed(ctx: LiveCtx, signer: ethers.Wallet, handle: string, contractAddress: string) {
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
      return { value: parsed, ms: Math.round(performance.now() - t0), permitMs, attempts: attempt };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      if (/not authorized|unauthorized|not allowed|acl|not ready|not found/i.test(msg) && attempt < 10) {
        await sleep(5000); // the relayer may not have seen the block that granted access yet
        continue;
      }
      throw new Error(`userDecrypt failed: ${msg}`);
    }
  }
}

async function main() {
  patchFetch();
  const provider = makeProvider();
  await probeRpcs(provider);
  const user = makeSigner(provider);
  const env = readEnvSepolia();
  if (!hasWatchtowerKey(env)) throw new Error("no watchtower key in .env.sepolia (the guardian of the test account)");
  const guardian = new ManagedWallet(sepoliaWatchtowerKey(env), provider);
  const st = load();
  const build = await snapshot();
  const fee = await provider.getFeeData();
  const log = (s: string) => console.log(s);
  log(`burner ${user.address} · ${eth(await provider.getBalance(user.address))} ETH · guardian ${guardian.address} · gas price ≈ ${gwei(fee.gasPrice!).toFixed(4)} gwei`);

  // ── library check: the reused F0.16 libraries must be this branch's code
  if (!st.libraries) {
    const links = { PolicyLib: F016_LIBS.PolicyLib, OpenLib: F016_LIBS.OpenLib, PinLib: F016_LIBS.PinLib };
    const res: Record<string, boolean> = {};
    for (const [n, a] of Object.entries(F016_LIBS)) res[n] = await libraryMatches(provider, n, a, links);
    st.libraries = { addresses: F016_LIBS, sameCode: res };
    save(st);
  }
  log(`F0.16 libraries, same code as this branch: ${JSON.stringify(st.libraries.sameCode)}`);
  if (!Object.values(st.libraries.sameCode).every(Boolean)) throw new Error("a reused library differs from this branch's code: deploy it anew instead");

  const registry = new ethers.Contract(REGISTRY, ["function getConfidentialTokenAddress(address) view returns (bool, address)"], provider);
  const [regValid, regWrapper] = await registry.getConfidentialTokenAddress(USDC_MOCK);
  if (!regValid || String(regWrapper).toLowerCase() !== CUSDC.toLowerCase()) throw new Error("the registry does not list this wrapper as valid");
  st.registry = { registry: REGISTRY, underlying: USDC_MOCK, wrapper: regWrapper, valid: regValid };
  const wrapper = new ethers.Contract(CUSDC, ["function wrap(address,uint256)", "function confidentialBalanceOf(address) view returns (bytes32)"], user);
  const usdc = new ethers.Contract(USDC_MOCK, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"], user);

  if (STEP === "check") {
    // Sepolia prices code at ≈1,560 gas per byte and a new storage slot at ≈111k gas (results/sepolia/gas-schedule.json)
    const est = { deploy: 62_000_000n, setup: 21_000_000n, t3open: 12n * 3_400_000n, t3exec: 12n * 1_800_000n, t1: 6n * 2_000_000n, t2: 10n * 2_500_000n, wrong: 2n * 2_000_000n };
    const gas = Object.values(est).reduce((a, b) => a + b, 0n);
    log(`estimate: ${gas} gas ≈ ${eth(gas * fee.gasPrice!)} ETH at the current price, plus bonds (refunded on a correct PIN; a wrong PIN's bond stays in the account)`);
    save(st);
    return;
  }

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
  await deploy("PrivateModule", [ENTRYPOINT_V08], { OpenLib: F016_LIBS.OpenLib });
  await deploy("EncryptedAccountP", [ENTRYPOINT_V08, ethers.ZeroAddress, st.contracts.PrivateModule], F016_LIBS);
  await deploy("EncryptedAccountFactory", [st.contracts.EncryptedAccountP], {});
  const factory = contractAt(build, "EncryptedAccountFactory", st.contracts.EncryptedAccountFactory, user);

  // ── account: the product setup of a private-mode account with a duress PIN (the test needs one for T3)
  if (!st.account) {
    const escape = ethers.Wallet.createRandom(); // E_addr: an ephemeral wallet, used once for its consent (K55)
    const friend = ethers.Wallet.createRandom().address; // the known recipient of the K-only path (never K's own address)
    const salt = ethers.id(`private-mode-feature-${Date.now()}`);
    const address: string = await factory.predictAddress(user.address, escape.address, guardian.address, DELAYS_P, salt);
    const sig = await escapeConsentSig(escape as unknown as ethers.Wallet, address, 0);
    st.account = { address, salt, escape: escape.address, guardian: guardian.address, friend, delays: DELAYS_P, setup: {} };
    save(st);
    const r = await send(user, "createAccount", () => factory.createAccountWithDelays.populateTransaction(user.address, escape.address, guardian.address, DELAYS_P, salt, sig));
    st.account.setup.createAccount = { ...r.tx, hcu: await hcuOf(provider, r.receipt) };
    save(st);
    log(`  account ${address} · gas ${r.tx.gasUsed}`);
  }
  const addr: string = st.account.address;
  const friend: string = st.account.friend;
  const acct = contractAt(build, "AccountP", addr, user);
  const ctx: LiveCtx = { provider, user, watchtower: guardian, client: await makeFhevmClient(provider), build, clientReadyMs: 0 };
  const enc = (values: { type: string; value: any }[]) => encryptTimed(ctx, values, addr, user.address);
  const step = async (label: string, run: () => Promise<{ tx: any; receipt: ethers.TransactionReceipt; encrypt?: any }>) => {
    if (st.account.setup[label]) return;
    const r = await run();
    st.account.setup[label] = { ...r.tx, hcu: await hcuOf(provider, r.receipt), ...(r.encrypt ? { encrypt: r.encrypt } : {}) };
    save(st);
    log(`  ${label}: gas ${r.tx.gasUsed} · HCU ${st.account.setup[label].hcu?.total ?? "-"} · ${r.tx.wallMs} ms`);
  };
  await step("setupPin", async () => {
    const fp = await pinFingerprint(TEST_PIN, 11155111n, addr);
    const dfp = await pinFingerprint(DURESS_PIN, 11155111n, addr);
    const e = await enc([
      { type: "euint64", value: fp },
      { type: "euint64", value: dfp },
      { type: "ebool", value: true },
    ]);
    return { ...(await send(user, "setupPin", () => acct.setupPin.populateTransaction(e.handles[0], e.handles[1], e.handles[2], e.inputProof))), encrypt: e.timing };
  });
  await step("setupAssetEth", async () => {
    const e = await enc([
      { type: "euint64", value: ETH_LIMITS.lmin },
      { type: "euint64", value: ETH_LIMITS.lmax },
      { type: "euint64", value: ETH_LIMITS.big },
    ]);
    return { ...(await send(user, "setupAsset ETH", () => acct.setupAsset.populateTransaction(ethers.ZeroAddress, ETH_UNIT, e.handles[0], e.handles[1], e.handles[2], e.inputProof))), encrypt: e.timing };
  });
  const knownR = [...Array(29).fill(ethers.ZeroAddress), friend];
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
  await step("privateSetupAsset", async () => {
    const e = await enc([
      { type: "euint64", value: PRIVATE_LIMITS.lmin },
      { type: "euint64", value: PRIVATE_LIMITS.lmax },
      { type: "euint64", value: DECOY },
    ]);
    return { ...(await send(user, "privateSetupAsset cUSDC", () => acct.privateSetupAsset.populateTransaction(CUSDC, e.handles[0], e.handles[1], e.handles[2], e.inputProof))), encrypt: e.timing };
  });
  await step("arm", () => send(user, "arm", () => acct.arm.populateTransaction()));
  await step("mintUsdc", () => send(user, "USDC mock mint", () => usdc.mint.populateTransaction(user.address, FUND)));
  await step("approveUsdc", () => send(user, "USDC approve", () => usdc.approve.populateTransaction(CUSDC, FUND)));
  await step("wrapToAccount", () => send(user, "cUSDC wrap → account", () => wrapper.wrap.populateTransaction(addr, FUND)));
  if (STEP === "setup") {
    log(`setup done · account ${addr} · watchtower guardian ${guardian.address}`);
    return;
  }

  const roles: Record<string, string> = { [addr.toLowerCase()]: "ACCOUNT", [CUSDC.toLowerCase()]: "TOKEN", [user.address.toLowerCase()]: "K", [guardian.address.toLowerCase()]: "G", [friend.toLowerCase()]: "R" };
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
  const txData = async (h: string) => (await provider.getTransaction(h))!.data;
  // a lagging backend may not know a block it just reported in a receipt: ask again
  const blockTs = async (bn: number) => {
    for (let k = 0; k < 30; k++) {
      const b = await provider.getBlock(bn).catch(() => null);
      if (b) return Number(b.timestamp);
      await sleep(1500);
    }
    throw new Error(`block ${bn} not found`);
  };
  /** When this client saw a transaction mined, and its block's timestamp: the reference times of the watchtower latency. */
  const seen = async (rc: ethers.TransactionReceipt) => ({ hash: rc.hash, block: rc.blockNumber, seenAt: Date.now(), blockTs: await blockTs(rc.blockNumber) });

  /** One PIN-gated op: open, fingerprint + encrypted guess with the bond, public decryption, finalize. */
  const pinFlow = async (label: string, pin: string, open: () => Promise<ethers.TransactionRequest>, expectOk = true) => {
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
    const guessSeen = await seen(g.receipt);
    const gs = await readAt<any>((x) => acct.getGuess(opId, x), g.receipt.blockNumber);
    const d = await publicDecryptWhenReady(ctx, [gs.okH]);
    const f = await send(user, `${label} finalizeGuess`, () => acct.finalizeGuess.populateTransaction(opId, d.abiEncodedClearValues, d.decryptionProof));
    const finSeen = await seen(f.receipt);
    const gf = parse(f.receipt, "GuessFinalized");
    if (Boolean(gf?.args.ok) !== expectOk) throw new Error(`${label}: GuessFinalized ok = ${gf?.args.ok}, expected ${expectOk}`);
    const doneMs = Math.round(performance.now() - t0);
    const [ho, hg, hf] = [await hcuOf(provider, o.receipt), await hcuOf(provider, g.receipt), await hcuOf(provider, f.receipt)];
    return {
      opId,
      block: f.receipt.blockNumber,
      readyAt: gf ? String(gf.args.readyAt) : null,
      result: parse(f.receipt, "PrivateOpExecuted") ? String(parse(f.receipt, "PrivateOpExecuted")!.args.result) : null,
      doneMs,
      fingerprintMs: fp.ms,
      encrypt: e.timing,
      bond: String(required),
      guessSeen,
      finSeen,
      open: { hash: o.tx.hash, gasUsed: o.tx.gasUsed, wallMs: o.tx.wallMs, hcu: ho, shape: shapeOf(o.receipt, await txData(o.tx.hash), ho, roles) },
      guess: { hash: g.tx.hash, gasUsed: g.tx.gasUsed, wallMs: g.tx.wallMs, hcu: hg, shape: shapeOf(g.receipt, await txData(g.tx.hash), hg, roles) },
      publicDecrypt: { waitedMs: d.waitedMs, attempts: d.attempts },
      finalize: { hash: f.tx.hash, gasUsed: f.tx.gasUsed, wallMs: f.tx.wallMs, hcu: hf, shape: shapeOf(f.receipt, await txData(f.tx.hash), hf, roles) },
    };
  };
  const refundNow = async (block?: number) => {
    const r: bigint = block ? await readAt((x) => acct.refundOf(user.address, x), block) : await acct.refundOf(user.address);
    if (r === 0n) return 0n;
    await send(user, "claimRefund", () => acct.claimRefund.populateTransaction(), { gasLimit: 150_000n });
    return r;
  };
  st.refunded ??= "0";
  const addRefund = (x: bigint) => {
    st.refunded = String(BigInt(st.refunded) + x);
  };

  /** Ops of the account opened by an earlier, interrupted run (from the logs), with their transactions. */
  const opLogs = async (opId: bigint) => {
    const topic = ethers.toBeHex(opId, 32);
    const from = Number(st.account.setup.createAccount.blockNumber);
    const logs = await provider.getLogs({ address: addr, fromBlock: from, toBlock: "latest", topics: [null, topic] });
    const by: Record<string, ethers.Log> = {};
    for (const l of logs) {
      try {
        const ev = acct.interface.parseLog(l);
        if (ev) by[ev.name] = l;
      } catch {
        /* other */
      }
    }
    return by;
  };
  const shapeFromChain = async (l: ethers.Log) => {
    const rc = (await provider.getTransactionReceipt(l.transactionHash))!;
    const h = await hcuOf(provider, rc);
    return { rc, rec: { hash: rc.hash, gasUsed: String(rc.gasUsed), wallMs: null, hcu: h, shape: shapeOf(rc, await txData(rc.hash), h, roles) } };
  };
  /** A T3 op that reached the chain but not the state file: finalize it if needed, then record it from its transactions. */
  const adoptT3 = async (k: number) => {
    const known = new Set((st.t3 as any[]).map((r) => String(r.opId)));
    const next = BigInt(Math.max(0, ...[...known].map(Number))) + 1n;
    const by = await opLogs(next);
    const opened = by.OpOpened ? acct.interface.parseLog(by.OpOpened)! : null;
    if (!opened || Number(opened.args.sub) !== 22) return false;
    if (!by.GuessSubmitted) throw new Error(`op ${next}: opened by an interrupted run but never guessed; finish it by hand`);
    if (!by.GuessFinalized) {
      const gs = await acct.getGuess(next);
      const d = await publicDecryptWhenReady(ctx, [gs.okH]);
      await send(user, `T3 transfer ${k + 1} finalizeGuess (recovered)`, () => acct.finalizeGuess.populateTransaction(next, d.abiEncodedClearValues, d.decryptionProof));
      Object.assign(by, await opLogs(next));
    }
    const gf = acct.interface.parseLog(by.GuessFinalized)!;
    if (!gf.args.ok) throw new Error(`op ${next}: the recovered guess was wrong`);
    const [o, g, f] = [await shapeFromChain(by.OpOpened), await shapeFromChain(by.GuessSubmitted), await shapeFromChain(by.GuessFinalized)];
    const mode = k % 2 === 0 ? "real" : "duress";
    st.t3.push({
      k: k + 1,
      mode,
      amount: T3_AMOUNTS[Math.floor(k / 2)],
      opId: next,
      block: f.rc.blockNumber,
      readyAt: String(gf.args.readyAt),
      result: null,
      doneMs: null,
      recovered: "an RPC error stopped the run after this op reached the chain; recorded from its transactions (no client-side times)",
      guessSeen: { hash: g.rc.hash, block: g.rc.blockNumber, seenAt: null, blockTs: await blockTs(g.rc.blockNumber) },
      finSeen: { hash: f.rc.hash, block: f.rc.blockNumber, seenAt: null, blockTs: await blockTs(f.rc.blockNumber) },
      open: o.rec,
      guess: g.rec,
      finalize: f.rec,
      exec: null,
    });
    addRefund(await refundNow());
    save(st);
    log(`  T3 transfer ${k + 1} (${mode}): recovered op ${next}, ready at ${new Date(Number(gf.args.readyAt) * 1000).toISOString()}`);
    return true;
  };

  if (STEP === "measure" || STEP === "t3open") {
    // ── T3, first half: 6 pairs of PIN-gated private transfers to the owner's wallet (it can read what it received),
    //    real PIN then duress PIN, scheduled now (72 h)
    st.t3 ??= [];
    while (st.t3.length < 2 * T3_AMOUNTS.length) {
      const k = st.t3.length;
      if (await adoptT3(k)) continue;
      const amount = T3_AMOUNTS[Math.floor(k / 2)];
      const mode = k % 2 === 0 ? "real" : "duress";
      const e = await enc([{ type: "euint64", value: amount }]);
      const r = await pinFlow(`T3 transfer ${k + 1} (${mode})`, mode === "real" ? TEST_PIN : DURESS_PIN, () => acct.openPrivateTransfer.populateTransaction(CUSDC, user.address, e.handles[0], e.inputProof));
      st.t3.push({ k: k + 1, mode, amount, ...r, exec: null });
      addRefund(await refundNow(r.block));
      save(st);
      log(`  T3 transfer ${k + 1} (${mode}): scheduled, op ${r.opId}, ready at ${new Date(Number(r.readyAt) * 1000).toISOString()} · ${r.doneMs} ms`);
    }
  }

  if (STEP === "measure" || STEP === "t1") {
    // ── T1 × N: one-transaction K-only private transfer to the known recipient; then one to an unknown address, which
    //    moves zero (the watchtower's silent-zero notice)
    st.t1 ??= [];
    while (st.t1.length < N + 1) {
      const i = st.t1.length + 1;
      const silent = i === N + 1;
      const to = silent ? user.address : friend;
      const t0 = performance.now();
      const e = await enc([{ type: "euint64", value: T1_AMOUNT }]);
      const r = await send(user, `T1 #${i}${silent ? " (unknown recipient)" : ""}`, () => acct.privateTransfer.populateTransaction(CUSDC, to, e.handles[0], e.inputProof));
      const totalMs = Math.round(performance.now() - t0);
      const decryptRequests = r.receipt.logs.filter((l) => l.topics[0] === ethers.id("AllowedForDecryption(address,bytes32[])")).length;
      st.t1.push({
        i,
        silent,
        to: silent ? "unknown" : "known",
        encrypt: e.timing,
        tx: { hash: r.tx.hash, gasUsed: r.tx.gasUsed, wallMs: r.tx.wallMs, inclusionMs: r.tx.inclusionMs, blocks: r.tx.blocksToInclusion },
        hcu: await hcuOf(provider, r.receipt),
        decryptRequests,
        totalMs,
        seen: await seen(r.receipt),
      });
      save(st);
      log(`  T1 #${i}${silent ? " (unknown recipient)" : ""}: ${totalMs} ms (proof ${e.timing.totalMs} + tx ${r.tx.wallMs}) · gas ${r.tx.gasUsed}`);
    }
  }

  if (STEP === "measure" || STEP === "t2") {
    // ── T2 × N: real-PIN view end to end, each paired with a duress-PIN view (T3 views on these contracts)
    st.t2 ??= [];
    st.t3views ??= [];
    const t1Moved = BigInt((st.t1 ?? []).filter((r: any) => !r.silent).length) * T1_AMOUNT;
    const bal = FUND - t1Moved;
    while (st.t2.length < N || st.t3views.length < N) {
      const i = Math.min(st.t2.length, st.t3views.length) + 1;
      if (st.t2.length < i) {
        const t0 = performance.now();
        const r = await pinFlow(`T2 #${i}`, TEST_PIN, () => acct.openPrivateView.populateTransaction(CUSDC));
        const u = await userDecryptTimed(ctx, user, r.result!, addr);
        st.t2.push({ i, ...r, userDecrypt: { ms: u.ms, permitMs: u.permitMs, attempts: u.attempts }, seenValue: u.value, expected: bal, correct: u.value === bal, totalMs: Math.round(performance.now() - t0) });
        addRefund(await refundNow(r.block));
        save(st);
        log(`  T2 #${i}: ${st.t2[i - 1].totalMs} ms · correct ${u.value === bal} · public decrypt ${r.publicDecrypt.waitedMs} ms · user decrypt ${u.ms} ms`);
      }
      if (st.t3views.length < i) {
        const r = await pinFlow(`T3 view #${i} (duress)`, DURESS_PIN, () => acct.openPrivateView.populateTransaction(CUSDC));
        const u = await userDecryptTimed(ctx, user, r.result!, addr);
        const exp = bal < DECOY ? bal : DECOY; // no T3 transfer has run yet: the whole decoy is left
        st.t3views.push({ i, ...r, seenValue: u.value, expected: exp, correct: u.value === exp });
        addRefund(await refundNow(r.block));
        save(st);
        log(`  T3 view #${i} (duress): correct ${u.value === exp}`);
      }
    }
  }

  if (STEP === "measure" || STEP === "wrongpin") {
    // ── 2 wrong PINs on the K-track (score 2: no back-off yet, no strike restriction); each bond stays in the account
    st.wrong ??= [];
    while (st.wrong.length < 2) {
      const i = st.wrong.length + 1;
      const r = await pinFlow(`wrong PIN #${i}`, WRONG_PIN, () => acct.openPrivateView.populateTransaction(CUSDC), false);
      st.wrong.push({ i, ...r });
      save(st);
      log(`  wrong PIN #${i}: finalized ok = false · ${r.doneMs} ms`);
    }
  }

  if (STEP === "wronglate") {
    // ── a wrong PIN that stays unfinalized for 90 s: the watchtower must report it from the public result at submit
    //    (off-chain), not at finalize. It is the third wrong PIN: the strike restriction (score 3) follows, which a
    //    scheduled transfer does not care about (executeOp checks no restriction).
    st.wrongLate ??= null;
    if (!st.wrongLate) {
      const t0 = performance.now();
      const fp = await pinFingerprint(WRONG_PIN, 11155111n, addr);
      const o = await send(user, "wrong PIN (late finalize) open", () => acct.openPrivateView.populateTransaction(CUSDC));
      const ev = parse(o.receipt, "OpOpened");
      const opId: bigint = ev!.args.opId;
      const e = await encryptTimed(ctx, [{ type: "euint64", value: guessValue(fp, BigInt(ev!.args.challenge)) }], addr, user.address);
      const [required] = await readAt<any>((x) => acct.ownerBond(x), o.receipt.blockNumber);
      const g = await send(user, "wrong PIN (late finalize) submitGuess", () => acct.submitGuess.populateTransaction(opId, BigInt(ev!.args.challenge), e.handles[0], e.inputProof, { value: required }));
      const guessSeen = await seen(g.receipt);
      log(`  wrong PIN (late finalize): guess in block ${g.receipt.blockNumber}; not finalizing for 90 s`);
      await sleep(90_000);
      const gs = await readAt<any>((x) => acct.getGuess(opId, x), g.receipt.blockNumber);
      const d = await publicDecryptWhenReady(ctx, [gs.okH]);
      const f = await send(user, "wrong PIN (late finalize) finalizeGuess", () => acct.finalizeGuess.populateTransaction(opId, d.abiEncodedClearValues, d.decryptionProof));
      st.wrongLate = { opId, bond: String(required), guessSeen, finSeen: await seen(f.receipt), gas: [o.tx.gasUsed, g.tx.gasUsed, f.tx.gasUsed].map(String), doneMs: Math.round(performance.now() - t0) };
      save(st);
      log(`  wrong PIN (late finalize): finalized after the wait`);
    }
  }

  if (STEP === "t3exec") {
    // ── T3, second half: every scheduled transfer, in order, once due; the owner's wallet reads what it received
    let decoyLeft = DECOY;
    for (const r0 of st.t3 as any[]) {
      if (r0.exec) {
        if (r0.mode === "duress") decoyLeft -= BigInt(r0.exec.moved);
        continue;
      }
      const now = Math.floor(Date.now() / 1000);
      if (now < Number(r0.readyAt) + 30) {
        log(`  T3 transfer ${r0.k}: not due until ${new Date(Number(r0.readyAt) * 1000).toISOString()}`);
        break;
      }
      const x = await send(user, `T3 execute ${r0.k} (${r0.mode})`, () => acct.executeOp.populateTransaction(BigInt(r0.opId)));
      const ex = parse(x.receipt, "PrivateOpExecuted");
      const moved = (await userDecryptTimed(ctx, user, String(ex!.args.result), CUSDC)).value;
      const amount = BigInt(r0.amount);
      const expected = r0.mode === "real" ? amount : amount <= decoyLeft ? amount : 0n;
      if (r0.mode === "duress") decoyLeft -= moved;
      const hx = await hcuOf(provider, x.receipt);
      r0.exec = { hash: x.tx.hash, gasUsed: x.tx.gasUsed, wallMs: x.tx.wallMs, hcu: hx, shape: shapeOf(x.receipt, await txData(x.tx.hash), hx, roles), moved, expected, correct: moved === expected };
      save(st);
      log(`  T3 execute ${r0.k} (${r0.mode}): ${amount} → moved ${moved} (expected ${expected}) · gas ${x.tx.gasUsed}`);
    }
  }

  if (STEP === "measure" || STEP === "summary" || STEP === "t3exec") writeSummary(st, log);
  log(`burner left ${eth(await provider.getBalance(user.address))} ETH`);
}

/** Pairwise comparison, timings, spike comparison, watchtower latencies. */
function writeSummary(st: St, log: (s: string) => void) {
  const s = (xs: number[]) => (xs.length ? { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), min: Math.min(...xs), max: Math.max(...xs) } : null);
  const t3diff: { pair: string; tx: string; metric: string; real: any; duress: any }[] = [];
  const cmp = (pair: string, a: any, b: any, txs: string[]) => {
    for (const tx of txs) {
      if (!a[tx] || !b[tx]) continue;
      for (const m of SHAPE_STRICT) if (JSON.stringify(a[tx].shape[m]) !== JSON.stringify(b[tx].shape[m])) t3diff.push({ pair, tx, metric: m, real: a[tx].shape[m], duress: b[tx].shape[m] });
    }
  };
  const t3 = (st.t3 ?? []) as any[];
  let pairs = 0;
  let execPairs = 0;
  for (let k = 0; k + 1 < t3.length; k += 2, pairs++) {
    cmp(`transfer ${k / 2 + 1}`, t3[k], t3[k + 1], ["open", "guess", "finalize"]);
    if (t3[k].exec && t3[k + 1].exec) {
      execPairs++;
      cmp(`transfer ${k / 2 + 1}`, t3[k].exec ? { execute: t3[k].exec } : {}, { execute: t3[k + 1].exec }, ["execute"]);
    }
  }
  const t2 = (st.t2 ?? []) as any[];
  const t3v = (st.t3views ?? []) as any[];
  for (let i = 0; i < Math.min(t2.length, t3v.length); i++) cmp(`view ${i + 1}`, t2[i], t3v[i], ["open", "guess", "finalize"]);

  // Which differences say anything about the PIN? The first transfer, the first guess and the first view open storage
  // slots for the first time (the real-PIN half ran first in each pair): an order effect. The rest is compared with the
  // spread of execution gas among transactions of the SAME mode (warm only): a difference inside that spread is noise.
  const kindOf = (pair: string) => (pair.startsWith("view") ? "view" : "transfer");
  const sets: Record<string, number[]> = {};
  const add = (kind: string, mode: string, tx: string, rec: any) => {
    if (rec?.[tx]?.shape) (sets[`${kind}|${mode}|${tx}`] ??= []).push(rec[tx].shape.exec);
  };
  t3.forEach((r, k) => k >= 2 && ["open", "guess", "finalize"].forEach((tx) => add("transfer", r.mode, tx, r)));
  t2.slice(1).forEach((r) => ["open", "guess", "finalize"].forEach((tx) => add("view", "real", tx, r)));
  t3v.slice(1).forEach((r) => ["open", "guess", "finalize"].forEach((tx) => add("view", "duress", tx, r)));
  const spread = (kind: string, tx: string) =>
    Math.max(
      ...["real", "duress"].map((m) => {
        const xs = sets[`${kind}|${m}|${tx}`] ?? [];
        return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
      }),
    );
  const classified = t3diff.map((d) => {
    const firstUse = (d.pair === "transfer 1" || d.pair === "view 1") && d.metric === "exec" && Math.abs(Number(d.real) - Number(d.duress)) > 1000;
    const within = d.metric === "exec" && !firstUse && Math.abs(Number(d.real) - Number(d.duress)) <= spread(kindOf(d.pair), d.tx);
    return { ...d, class: firstUse ? "first use of a storage slot (order, not PIN)" : within ? `within the same-mode spread (${spread(kindOf(d.pair), d.tx)} gas)` : "UNEXPLAINED" };
  });

  // watchtower: the fake channel's file (written by the watchtower process, not by this script)
  const raw: any[] = fs.existsSync(NOTICES)
    ? fs
        .readFileSync(NOTICES, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  // one notice per (recipient, kind, transaction), the earliest: a second watchtower process ran for a few minutes
  // after a restart (its stop did not reach the child process), and wrote the same notices again
  const keys = new Set<string>();
  const notices = [...raw]
    .sort((a, b) => a.at - b.at)
    .filter((n) => {
      const k = `${n.to}|${n.dest}|${n.ref?.kind}|${n.ref?.txHash}`;
      if (keys.has(k)) return false;
      keys.add(k);
      return true;
    });
  const latency = (kind: string, refs: { hash: string; seenAt: number | null; blockTs: number }[]) => {
    const fromSeen: number[] = [];
    const fromBlock: number[] = [];
    let matched = 0;
    for (const r of refs) {
      const n = notices.find((x: any) => x.ref?.kind === kind && String(x.ref?.txHash).toLowerCase() === r.hash.toLowerCase());
      if (!n) continue;
      matched++;
      if (r.seenAt) fromSeen.push(n.at - r.seenAt);
      fromBlock.push(n.at - r.blockTs * 1000);
    }
    return { events: refs.length, notified: matched, msAfterClientSawTx: s(fromSeen), msAfterBlockTimestamp: s(fromBlock) };
  };
  const duressRefs = [...t3.filter((r) => r.mode === "duress"), ...t3v].map((r) => r.guessSeen);
  const realRefs = [...t3.filter((r) => r.mode === "real"), ...t2].map((r) => r.guessSeen);
  const t1 = (st.t1 ?? []) as any[];
  const wt = {
    file: path.relative(ROOT, NOTICES).replace(/\\/g, "/"),
    notices: notices.length,
    duplicatesRemoved: raw.length - notices.length,
    duressAlarm: latency("duress", duressRefs),
    duressAlarmOnRealPin: notices.filter((n: any) => n.ref?.kind === "duress" && realRefs.some((r) => r.hash.toLowerCase() === String(n.ref?.txHash).toLowerCase())).length,
    duressToOwner: notices.filter((n: any) => n.ref?.kind === "duress" && n.to !== "trusted").length,
    // the watchtower reports a wrong PIN at submit (from the public result) since its restart before these runs
    wrongPin: latency("wrong-pin", ((st.wrong ?? []) as any[]).map((r) => r.guessSeen)),
    wrongPinReportedAtFinalize: latency("wrong-pin", ((st.wrong ?? []) as any[]).map((r) => r.finSeen)),
    wrongPinAtSubmit: latency("wrong-pin", st.wrongLate ? [st.wrongLate.guessSeen] : []),
    wrongPinLateFinalizedAfterNoticeMs: (() => {
      const n = st.wrongLate && notices.find((x: any) => x.ref?.kind === "wrong-pin" && String(x.ref?.txHash).toLowerCase() === st.wrongLate.guessSeen.hash.toLowerCase());
      return n ? st.wrongLate.finSeen.seenAt - n.at : null;
    })(),
    restrictionNotices: notices.filter((n: any) => n.ref?.kind === "restriction").length,
    silentZero: latency("private-silent-zero", t1.filter((r) => r.silent).map((r) => r.seen)),
    delivered: latency("private-delivered", t1.filter((r) => !r.silent).map((r) => r.seen)),
    noticeWithDigits: notices.filter((n: any) => /\d{3,}/.test(String(n.text).replace(/0x[0-9a-fA-F]+/g, "").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z/g, ""))).length,
  };

  const spikeFile = path.join(ROOT, "results", "spike", "sepolia", "private-mode-sepolia.json");
  const spike = fs.existsSync(spikeFile) ? JSON.parse(fs.readFileSync(spikeFile, "utf8")) : null;
  const t1k = t1.filter((r) => !r.silent);
  const summary = {
    generatedAt: new Date().toISOString(),
    evidence: "[M] Sepolia, feature/private-mode contracts, official cUSDC (Mock) wrapper from the Zama Wrappers Registry",
    contracts: st.contracts,
    reusedF016Libraries: st.libraries,
    account: st.account?.address,
    guardian: st.account?.guardian,
    deployGas: Object.fromEntries(Object.entries(st.deploys ?? {}).map(([k, v]: any) => [k, Number(v.gasUsed)])),
    setupGas: Object.fromEntries(Object.entries(st.account?.setup ?? {}).map(([k, v]: any) => [k, Number(v.gasUsed)])),
    T1: t1k.length
      ? {
          totalMs: s(t1k.map((r) => r.totalMs)),
          inputProofMs: s(t1k.map((r) => r.encrypt.totalMs)),
          txMs: s(t1k.map((r) => r.tx.wallMs)),
          gas: s(t1k.map((r) => Number(r.tx.gasUsed))),
          gasSteady: s(t1k.slice(1).map((r) => Number(r.tx.gasUsed))),
          hcu: s(t1k.map((r) => r.hcu?.total ?? 0)),
          decryptRequests: t1k.map((r) => r.decryptRequests),
          unknownRecipient: t1.find((r) => r.silent) ? { gas: Number(t1.find((r) => r.silent).tx.gasUsed), hcu: t1.find((r) => r.silent).hcu?.total ?? null } : null,
          spike: spike ? { totalMs: spike.T1.totalMs, gas: spike.T1.gas, hcu: spike.T1.hcu } : null,
        }
      : null,
    T2: t2.length
      ? {
          totalMs: s(t2.map((r) => r.totalMs)),
          fingerprintMs: s(t2.map((r) => r.fingerprintMs)),
          inputProofMs: s(t2.map((r) => r.encrypt.totalMs)),
          txMs: s(t2.map((r) => r.open.wallMs + r.guess.wallMs + r.finalize.wallMs)),
          publicDecryptMs: s(t2.map((r) => r.publicDecrypt.waitedMs)),
          userDecryptMs: s(t2.map((r) => r.userDecrypt.ms)),
          gasTotal: s(t2.map((r) => Number(r.open.gasUsed) + Number(r.guess.gasUsed) + Number(r.finalize.gasUsed))),
          hcuTotal: s(t2.map((r) => (r.open.hcu?.total ?? 0) + (r.guess.hcu?.total ?? 0) + (r.finalize.hcu?.total ?? 0))),
          allCorrect: t2.every((r) => r.correct),
          spike: spike ? { totalMs: spike.T2.totalMs, gasTotal: spike.T2.gasTotal } : null,
        }
      : null,
    T3: {
      note: "production executor: real-PIN vs duress-PIN transactions compared pair by pair (execution gas = gas minus calldata gas)",
      transferPairsScheduled: pairs,
      transferPairsExecuted: execPairs,
      viewPairs: Math.min(t2.length, t3v.length),
      txCompared: 3 * (pairs + Math.min(t2.length, t3v.length)) + execPairs,
      differences: t3diff.length,
      unexplained: classified.filter((d) => d.class === "UNEXPLAINED").length,
      sameModeExecSpread: Object.fromEntries(Object.entries(sets).map(([k, xs]) => [k, xs.length ? Math.max(...xs) - Math.min(...xs) : 0])),
      list: classified.slice(0, 30),
      viewsCorrect: t3v.every((r) => r.correct),
      transfersCorrect: t3.every((r) => !r.exec || r.exec.correct),
      scheduleMs: s(t3.filter((r) => r.doneMs !== null).map((r) => r.doneMs)),
      recovered: t3.filter((r) => r.recovered).map((r) => r.k),
      scheduleGas: s(t3.map((r) => Number(r.open.gasUsed) + Number(r.guess.gasUsed) + Number(r.finalize.gasUsed))),
      scheduleHcu: s(t3.map((r) => (r.open.hcu?.total ?? 0) + (r.guess.hcu?.total ?? 0) + (r.finalize.hcu?.total ?? 0))),
      executeGas: s(t3.filter((r) => r.exec).map((r) => Number(r.exec.gasUsed))),
      executeHcu: s(t3.filter((r) => r.exec).map((r) => r.exec.hcu?.total ?? 0)),
      gasPairs: t3
        .filter((_r, k) => k % 2 === 0 && t3[k + 1])
        .map((r, j) => {
          const d = t3[2 * j + 1];
          const g = (x: any) => [x.open.gasUsed, x.guess.gasUsed, x.finalize.gasUsed, x.exec?.gasUsed ?? null].map((v) => (v === null ? null : Number(v)));
          return { pair: j + 1, amount: String(r.amount), real: g(r), duress: g(d) };
        }),
      readyAt: t3.map((r) => ({ k: r.k, mode: r.mode, readyAt: r.readyAt ? new Date(Number(r.readyAt) * 1000).toISOString() : null })),
    },
    wrongPin: ((st.wrong ?? []) as any[]).map((r) => ({ i: r.i, doneMs: r.doneMs, gas: [r.open.gasUsed, r.guess.gasUsed, r.finalize.gasUsed].map(Number) })),
    watchtower: wt,
    refunded: st.refunded,
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  log(`summary: T3 ${t3diff.length} differences in ${summary.T3.txCompared} transaction pairs · watchtower ${notices.length} notices`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(String(e?.message ?? e).slice(0, 600));
    process.exit(1);
  });
