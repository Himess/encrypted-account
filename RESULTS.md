# RESULTS

Round 2 is on top; the Round 1 results are kept unchanged below. Evidence classes: **[M]** measured · **[Mock]** ran on
Zama's mock · **[V]** verified by reading code or documentation · **[D]** Zama documentation · **[I]** inference.

# Round 2 — E1, Y1/Y2 fixes, A/B hot path, mobile Argon2id

- **Input:** the Round 2 work package (8 November 2026), §4; its general rules (§4.0) apply to every package.
- **Status (10 November 2026):** F0.8 ✔ · **F0.9 ✔** — E1 PIN flow p95 47.7 s: **GO** with a desktop client; K-only
  hot path p95 40.9 s (60 s threshold accepted); the empty-proof pattern confirmed live · F0.12 ◐ (Android ✔, no iOS
  device) · **9 November interim decision** (work package §7): order F0.12b → F0.10 → F0.11 → F0.15 → F0.14 · **F0.12b ✔ —
  mobile web GO** (Galaxy A73, local proof p95 13.65 s ≤ 16 s; tight margin) · **F0.10 ✔** — Y1/Y2 fixes, K53, K55:
  `npm test` 82/82 green (Y1 included); the worst Round 1 Y1 scenario drops from 2,307 guesses in 30 days to 12, and to
  4–5 with an escape or a rotation with D; the Sepolia smoke test passed (E1 p50 23.9 / p95 46.9 s, n = 5). **Second
  interim decision** (§8): **F0.10 addendum ✔** (E_addr ≠ watchtower and ≠ K, restriction re-set, open-approval warning
  in the watchtower; 87/87). **F0.11 ✔** — B variant (public list, public limit, K-only in one transaction): on Sepolia
  K-only p50 7.2 / p95 14.6 s and 59,820 gas, on A 20.1 / 26.3 s and 1,949,477 gas (N = 30, interleaved); setup 5.2×
  cheaper; lists and limit public, no tripwire; `npm test` 98/98. **F0.15 ✔** — new storage slots on a PIN-verified
  transfer 16 → 8 (Sepolia, block access list); gas −22.6% on Sepolia (≈ −3.5% on today's mainnet schedule); stored
  back-off: the 30-day worst case is 12 guesses without a reaction and 4 with an escape; `npm test` 101/101. Next: F0.14.

## F0.8 · Burner wallet and Sepolia preparation

| Step | Status | Evidence |
|---|---|---|
| 1. Burner wallet | ✔ `0xcBdaED7D91644c771Aa84C5AbE5afFBB42a4d502`; key only in `.env.sepolia` (gitignored) | `results/sepolia/burner.json` |
| 2. Hardhat `sepolia` network + RPC | ✔ key and RPC from `.env.sepolia`; the scripts use a provider that rotates between 3 public RPCs and retries with back-off (`scripts/lib/net.ts`) | `hardhat.config.ts`, `scripts/lib/` |
| 3. Gas price and funding | ✔ recommended **0.06 Sepolia ETH** (below) | `results/sepolia/funding-estimate.json` |
| 4. Funding | ✔ **0.1 Sepolia ETH** arrived: block 12,092,705 (19:57:36 UTC), tx `0xa111e8d7f8c9486aab0d2640487f50d6860d1d9f9fd971bcab1f4d8204c9a1c6` [M]. The watchtower (guardian) wallet `0x8e98…7B7A` was funded from the burner with 0.012 ETH (tx `0x11321923…828d1c`) | chain (the transactions above) |
| 5. EntryPoint v0.8 + relayer smoke test | ✔ **passed** [M] (21:00 UTC, on our own `ToolchainSpike` contract): encrypted input `setSecret` (453,464 gas, tx `0xb3a5…70cd`) → encrypted comparison `guessWithChallenge` (630,503 gas, `0x686c…bcf4`) → public decryption from the relayer in **2.9 s**, ready in the block in which the transaction was included → on-chain verification of the KMS signatures `verify` (469,425 gas, `0x8180…7d31`). Every transaction was included in 1 block with a 0.05 gwei priority fee. EntryPoint v0.8 at the canonical address (21,738 bytes of code) | `results/sepolia/smoke.json` |

**Acceptance [M]:** address printed; the key is in no output — `scripts/check-secrets.ts` scanned 103 files in the
repository and the local session logs on 8 November at 21:3x UTC, no match; the folder was not a git repository at the
time; smoke test passed. F0.8 closed.

**Sepolia gas price [M] (block 12,092,528, 19:20 UTC):** base fee a few wei (≈ 0 gwei; also over the last 100 blocks), the
node's priority suggestion ≈ 0, the blocks' p50 priority reward 1 gwei. The scripts clip the priority fee to a 0.05 gwei
floor; unit price ≈ 0.05 gwei. Whether the low fee hurts inclusion time was to be measured in the smoke test (E1 must be
representative). *Result:* the smoke test's three transactions were included in the first block; of F0.9's 150
transactions, 92% landed in the first block after sending, 8% in the second. Most long inclusions come from missed slots
on Sepolia (10%); how much of the second-block cases is due to the low fee was not separated (F0.9 inclusion analysis).

| Scenario | Unit price | §3 plan (200M gas) × 1.3 + 0.005 ETH |
|---|---:|---:|
| Current price | 0.05 gwei | 0.018 ETH |
| 1 gwei | 1 gwei | 0.265 ETH |
| 5 gwei | 5 gwei | 1.305 ETH |
| 10 gwei | 10 gwei | 2.605 ETH |

Recommendation: 3× the formula (0.018 ETH), rounded to 0.01: **0.06 ETH**. ≈ 0.002 ETH is enough to start; if the balance
runs out, the scripts print the missing amount and stop, and resume where they left off after funding. Cross-check: one
full deployment from the bytecode ≈ 15.4M gas (×2 = 30.7M; plan 30M) [I].

**Pre-checks [M]:** EntryPoint v0.8's canonical deployment exists on Sepolia (`0x4337…f108`; we do not deploy our own);
the ACL, FHEVMExecutor, KMSVerifier, InputVerifier and ProtocolConfig addresses have code; the relayer
(`relayer.testnet.zama.org`) works without an API key: client ready (key download) ≈ 6.0 s, off-chain input proof
≈ 4.9 s. `sepolia.drpc.org` returns 400 to keyless requests, so it was removed from the list.

**Incident and mitigation.** The first burner's key (`0xf36a…5468`) ended up in a session log, before funding, because of a
repository search that did not exclude `.env.sepolia`. With a zero balance it was retired (`.env.sepolia.old-*`,
gitignored) and a new burner was generated; no loss. Mitigations: searches exclude `.env*` files;
`scripts/check-secrets.ts` scans the repository and the local session logs, and verifies the `.gitignore` patterns with
`git check-ignore` in a temporary git repository. Last check: the new key is in none of the 78 files outside
`.env.sepolia`; the folder was not a git repository, no commit history (`results/sepolia/secret-check.json`).

## F0.9 · E1 and live checks (baseline, Round 1 code)

- **Code:** the Round 1 build was deployed unchanged (`results/sepolia/baseline/build.json`, source digests recorded); the
  evidence contract for the empty-proof pattern, `NaivePinVerifier`, was added after verifying that its source matched the
  digest recorded at baseline time.
- **Run:** 8 November 2026, 21:54–22:43 UTC, Sepolia blocks 12,093,249–12,093,473. 30 PIN + 30 hot-path samples
  interleaved, random order within each pair, random 3–20 s pause between samples; priority fee 0.05 gwei. Desktop client
  (Ryzen 5 5600, Node 22, `@fhevm/sdk` 0.13.7, TFHE WASM with 12 threads); watchtower v0 is a separate wallet that decrypts
  and finalizes as soon as it sees the event. The measurement accounts were set up with short test delays
  (`pinTransfer = 0`), so policy waits did not enter the measurement; the production delays (1 h / 48 h / 24 h …) are in
  `results/sepolia/setup.json`.
- **Raw data:** `results/sepolia/e1.json`, `results/sepolia/hot-path.json`. Each sample has every transaction's tx hash,
  block, UTC timestamp, gas, HCU, retries and the block at which decryption was ready.

### Go/no-go [M]

| Flow | n | p50 | p95 | max | Criterion | Result |
|---|---:|---:|---:|---:|---|---|
| **E1 PIN flow** (PIN entry → `finalizeGuess` included) | 30/30 | **24.4 s** | **47.7 s** | 48.7 s | p95 < 60 s (design doc v0.3 §31.1) | **GO** (desktop client) |
| PIN flow, click → finalize (including op opening) | 30/30 | 31.1 s | 54.8 s | 56.2 s | — | info |
| **K-only hot path** (click → transfer executed) | 30/30 | **19.9 s** | **40.9 s** | 46.4 s | proposed 60 s (accepted) | below threshold |

No failed samples: `ok = true` in 30/30 PIN samples, and the transfer executed in 30/30 hot-path samples. In 7 of 180
transactions the gas estimate was retried (a backend of the load-balanced RPC that had not yet seen the previous block);
a fee-bump replacement was never needed. At n = 30, p95 is the 29th sorted value; it is sensitive to occasional late
blocks.

### E1 breakdown (n = 30)

| Component | p50 | p95 | max | Note |
|---|---:|---:|---:|---|
| Argon2id (client, v1) | 175 ms | 207 ms | 219 ms | on a phone (Galaxy A73) p95 322 ms, F0.12 |
| Challenge (`challengeOf`, RPC) | 0.10 s | 0.34 s | 1.3 s | |
| Encryption + input proof | 4.8 s | 6.0 s | 9.7 s | local 4.1 / 4.5 s (12 threads), relayer 0.6 / 1.8 s |
| `submitGuess` inclusion | 7.0 s | 18.2 s | 20.0 s | 1st block after sending (p95: 2nd) |
| Public decryption ready | 5.0 s | 6.0 s | 6.7 s | ready before the next block in 30/30 samples (R9: 0 blocks) |
| `finalizeGuess` inclusion (watchtower) | 7.1 s | 19.8 s | 32.2 s | exactly one block after `submitGuess` in 30/30 samples |
| *(op opening; not part of E1)* | 6.2 s | 14.4 s | 15.6 s | |

```
E1 total (n = 30)             Hot path total (n = 30)
20–25 s | ███████████████████ 19     10–15 s | ████ 4
25–30 s | ███ 3                      15–20 s | ████████████ 12
30–35 s | █ 1                        20–25 s | ██████ 6
35–40 s | █████ 5                    25–30 s | █ 1
40–45 s |  0                         30–35 s | █████ 5
45–50 s | ██ 2                       35–40 s |  0
                                     40–45 s | █ 1
                                     45–50 s | █ 1
```

**Structure [M].** E1 ≈ client time (≈ 5 s) + two consecutive blocks. Since decryption was ready before the next block in
every sample, `finalizeGuess` always lands in the block after `submitGuess`; the typical total is ≈ 24 s, and each late
slot adds ≈ +12 s (the 35–40 and 45–50 s peaks). In the two longest samples (48.7 and 47.7 s) individual inclusions
determine the time (a 32.2 s finalize; 17.9 + 19.8 s), not decryption.

### Hot-path breakdown (n = 30)

| Component | p50 | p95 | max |
|---|---:|---:|---:|
| `requestTransfer` inclusion | 7.0 s | 14.8 s | 21.5 s |
| `ok` decryption ready | 7.2 s | 9.2 s | 9.4 s |
| `finalizeEvaluation` inclusion (= transfer executed) | 5.0 s | 18.2 s | 31.5 s |

On the hot path decryption is ≈ 2 s slower than in E1: the FHE depth of the `ok` bit is 634,032 HCU (isIn N = 30 +
threshold + sticky tripwire), that of the PIN result 302,000 HCU [M]; the difference is consistent with the coprocessors'
sequential compute time [I]. A plain ETH/ERC-20 transfer is a single inclusion (single-inclusion p50 ≈ 7 s in this run);
the hot path is ≈ 3× that: two inclusions + decryption. The B variant in F0.11 reduces this path to a single transaction in
open mode.

### Inclusion: what drives the tail [M]

150 transactions (E1: open, guess, finalize; hot path: request, finalize): inclusion p50 6.5 s · p95 17.9 s · max 31.8 s;
slot start to receipt seen p50 0.9 s · p95 2.5 s. 92% of the transactions landed in the first block after sending. The
share of missed slots before the inclusion block is 10% (block interval 24 or 36 s); most of the 15 inclusions above 15 s
are explained by a missed slot, the rest by landing in the second block. How much of the 8% that landed in the second
block is due to the low priority fee (0.05 gwei) was not separated. Since mainnet has a lower missed-slot rate, p95 is
expected to be shorter there [I]. Evidence: `results/sepolia/inclusion-analysis.json`.

### Mobile reading: what determines E1 on a phone [M + I]

- **Argon2id is not decisive:** on a phone (Galaxy A73) v1 p95 322 ms; +0.1 s versus desktop (F0.12).
- **The input proof is decisive:** the local part of encryption + input proof on desktop is p50 4.5 s / p95 4.9 s with 12
  threads, **p50 12.0 s / p95 12.7 s single-threaded** (2.65×; n = 8 + 8, `results/sepolia/enc-threads.json`). On a web
  page without COOP/COEP headers `@fhevm/sdk` runs TFHE single-threaded [V: SDK `init-p.js`]; the F0.12 page also opened
  with `crossOriginIsolated = false` on the phone.
- **Sensitivity [I]:** E1(phone) ≈ E1(desktop) − local proof(desktop) + local proof(phone) + 0.1 s. Since the client time
  is nearly constant, adding it to percentiles is a first-order estimate.

| Local proof time on the phone | E1 p50 ≈ | E1 p95 ≈ | v0.3 criterion |
|---|---:|---:|---|
| 4.5 s (desktop, 12 threads) | 25 s | 48 s | GO |
| 12 s (desktop, single thread) | 32 s | 55 s | GO (tight) |
| 20 s | 40 s | 63 s | NO-GO |
| 30 s | 50 s | 73 s | NO-GO |

  Break-even: the local proof on the phone must stay below **≈ 16.6 s**. **Result:** E1 is GO with a desktop client; the
  mobile decision cannot be made without measuring the input proof on a phone → recommendation **F0.12b**: add
  input-proof generation to the F0.12 page (with and without COOP/COEP). Client options: multithreading with COOP/COEP; a
  "pipeline" (the PIN is asked while the op is being opened, the challenge is computed on the client, and the proof
  overlaps with the inclusion of the opening transaction, ≈ 6–7 s gain [I]); a native mobile SDK.

### Live checks [M] — `results/sepolia/live-checks.json`

| Check | Result | Evidence (tx) |
|---|---|---|
| `isIn`, 60 elements (Bench) | ✔ worked: 776,458 gas, HCU 885,032 (same as mock) | `0xa3ab0fbf…29d5d` |
| `isIn`, 61 elements | ✔ reverted: FHEVMExecutor `FHECollectionSizeInvalid` (limit 60 for types of ≥ 64 bits; same as mock) | `0x54ada787…43483` (status 0) |
| Empty proof, our own test contract, someone else's handle | ✔ `SenderNotAllowedToUseHandle` — same as mock | `0xdf59c907…534ca` |
| Empty proof, zero handle | returns an encrypted 0 without a proof (one `TrivialEncrypt`), consistent with [V] | `0x540ef4b1…171b4` |
| **Empty-proof pattern, live:** self-call + empty proof on the naive verifier | ✔ **`ok = true` without knowing the PIN** (read via public decryption): the pattern is not mock-specific, it holds on the live protocol too | `0x774031c5…5f738` |
| Empty-proof pattern: the same attempt without a self-call | ✔ `SenderNotAllowedToUseHandle` | `0xf420e9b6…e41d30` |
| `EncryptedAccount` with an empty proof | ✔ `EmptyInputProof`; the op stayed in `NeedsPin` | `0x69aa9d65…f88d3` |
| **AA (E3 live):** UserOp → pending op → PIN from inside a UserOp (input context: account, EntryPoint) → finalize → execution | ✔ canonical EntryPoint v0.8, bundler = watchtower wallet, `TestPaymaster`; PIN entry → finalize 24.1 s | open `0x2771c982…aefb1` · guess `0x494d1381…fc990c` · finalize `0x95a3a1b1…4b1267` · execution `0x534184b7…7e9dac` |
| AA: input with the wrong context (user = owner EOA) | ✔ UserOp failed, `InvalidSigner` (InputVerifier); op `NeedsPin` | `0x4ba7d61f…e08f1` |
| AA: UserOp without a paymaster (S19) and with a forged signature | ✔ both `FailedOp` in validation (eth_call) | — |
| Admin path: RESET_TRIP (K+P) | ✔ executed inside finalize; τ redrawn (HCU 977,064 = mock) | `0xad5a2f78…fa673b2` |
| Escape: start → 120 s → execute | ✔ 0 FHE executor events in both transactions; all 0.000199 ETH on the account went to the escape address | `0xaa74ba4c…bd157` · `0x4e41a26e…65c4e2` |
| Is HCU readable live | ✔ `HCULimit.getBlockMeter()` (eth_call at the transaction's block) equal to the HCU computed from events in E1/hot-path transactions 168 times, different 0 times (12 unreadable); values identical to mock | `hcu` fields of the e1/hot JSON |

**HCU is now measured [M]:** setupPin 79,000 · setupAsset 1,195,064 · K-only request 774,036 (depth 634,032) ·
`submitGuess` (outflow) 698,002 (depth 302,000) · `executeOp` (+ auto-known) 667,032 · finalize + resetTrip 977,064 ·
isIn N = 60 885,032. The Round 1 [Mock] HCU table was confirmed live exactly.

### Cost model: live gas [M] vs mock [Mock] — `results/sepolia/cost-model-live.{json,csv}`

Sepolia runs a fork ahead of mainnet ([M] `gas-schedule.json` / `gas-schedule-mainnet.json`, 8 November):
`blockAccessListHash` and `slotNumber` in the header, block gas limit 200M; **new storage slot 110,983 gas** (mainnet
22,445), **code byte 1,542 gas** (mainnet 202), **new-account surcharge 186,391** (mainnet 25,000). The new slots and new
accounts opened by each flow's representative transaction were counted from the block access list
(`eth_getBlockAccessList`); removing this repricing gives a "today's mainnet equivalent" [I].

| Flow | Mock | Sepolia (median, n) | Diff | New slots (BAL) | Today's mainnet equivalent [I] |
|---|---:|---:|---:|---:|---:|
| `factory.createAccount` | 281,728 | 1,292,216 (3) | +359% | 9 + 1 account | 273,683 |
| `setupPin` | 818,196 | 854,124 (3) | +4% | 4 | 499,972 |
| `setupAsset` (ETH, τ draw) | 1,411,179 | 1,943,552 (3) | +38% | 13 | 792,558 |
| `setupKnown` (12 eaddress) | 2,062,794 | 3,787,337 (6) | +84% | 27 | 1,396,811 |
| `requestTransfer` K-only | 1,226,772 | 1,524,305 (30) | +24% | 9 | 727,463 |
| `finalizeEvaluation` (+ transfer) | 303,454 | 422,803 (30) | +39% | 0 | 422,803 |
| `requestTransfer` PIN path (opening) | 136,397 | 490,253 (30) | +259% | 4 | 136,101 |
| `submitGuess` (outflow) | 1,206,087 | 1,711,020 (30) | +42% | 11 | 737,102 |
| `finalizeGuess` (2 handles) | 303,015 | 526,028 (30) | +74% | 1 | 437,490 |
| `executeOp` (+ auto-known) | 729,222 | 765,223 (30) | +5% | 1 + 1 account | 515,294 |
| `submitGuess` (admin) | 1,043,475 | 1,435,266 (1) | +38% | 9 | 638,424 |
| `finalizeGuess` + resetTrip | 881,249 | 967,852 (1) | +10% | 3 | 702,238 |
| `tightenLimits` (K-only) | 907,276 | 895,113 (1) | −1% | 4 | 540,961 |
| `removeKnown` (K-only) | 509,993 | 427,404 (1) | −16% | 1 | 338,866 |
| `startEscape` / `executeEscape` | 34,534 / 50,158 | 36,134 / 38,457 | +5% / −23% | 0 | same |
| Bench `isIn` N = 30 / 60 | 555,239 / 899,365 | 447,929 / 776,458 | −19% / −14% | 1 / 2 | 359,391 / 599,382 |
| AA `handleOps`: open / guess | — | 687,601 / 1,802,139 | — | 5 / 11 | 244,911 / 828,221 |

| Flow total | Mock | **Sepolia [M]** | Today's mainnet equivalent [I] |
|---|---:|---:|---:|
| K-only transfer (request + finalize) | 1.53M | **1.95M** | ≈ 1.15M |
| PIN transfer (open + guess + finalize + execute) | 2.37M | **3.49M** | ≈ 1.83M |
| Setup, one asset (9 transactions) | ≈ 9.3M [I] | **17.03M** | ≈ 6.45M |
| Full deployment (9 contracts) | ≈ 15.4M [I] | **109.4M** | ≈ 15.4M |

**Explaining the differences (> 10%):**
1. **Sepolia's gas schedule [M].** FHE flows open new slots in the ACL and in the account for every new handle (PIN
   transfer: 17 new slots + 1 new account). The model was validated on non-FHE transactions: `createAccount` equivalent
   273,683, mock 281,728 (−3%); op opening 136,101, mock 136,397 (−0.2%).
2. **The mock's cleartext executor [V].** For every FHE result and input the mock writes the plaintext to a separate
   `CleartextDB` contract with `set(handle, value)`; this storage does not exist live. So the mock overstates today's
   mainnet for FHE transactions (`submitGuess` ≈ 0.74M against 1.21M; K-only request ≈ 0.73M against 1.23M). For `isIn`,
   `tightenLimits` and `removeKnown` this overhead is larger than the repricing, so live < mock.
3. **KMS signature verification [M + I].** The live decryption proof carries 7 KMS signatures (489 bytes; threshold 7/13).
   The finalize transactions are 39–74% more expensive than mock although they open 0–1 new slots; this is consistent with
   verifying more signatures than the mock KMS. An exact breakdown needs a trace (`debug_traceTransaction` is not
   available on the public RPCs).
4. **Escape:** the mock also swept a token; live only ETH.

**Impact on cost planning [I]:** on today's mainnet schedule a K-only transfer costs ≈ 1.15M and a PIN transfer ≈ 1.83M
gas (lower than Round 1's mock-based estimate of 1.53M / 2.37M). When Sepolia's fork reaches mainnet they become
1.95M / 3.49M, and state growth becomes the dominant cost item. Compressing the op record and reducing the intermediate
handles that receive persistent ACL permissions (shrinking state growth) should feed into the Phase 1 design.

### Budget [M]

F0.9 spent ≈ **0.0173 ETH** in gas (≈ 345M gas at a unit price of ≈ 0.05 gwei; the §3 plan was 200M — the difference comes
from the new gas schedule: deployment 109M, three account setups 3 × 17M). Remaining: burner 0.0719 ETH, watchtower
0.0095 ETH; 0.00034 ETH on the measurement accounts and 0.00045 ETH in the paymaster deposit (TestPaymaster has no withdraw
function).

### Limits

Desktop client (input proof not measured on a phone, F0.12b). The watchtower runs in the same process as the measurement:
event-detection delay ≈ 0; in production, block polling adds ≤ ~1 s [I]. On Sepolia the base fee is ≈ 0 and the
missed-slot rate is 10%; on mainnet the fee market and the slot pattern differ. "Today's mainnet equivalent" is a model
[I]. The relayer is Zama's keyless Sepolia relayer; on mainnet there is an API key and a fee in ZAMA. At n = 30, p95 is
sensitive to occasional late blocks.

### Open questions and next steps

1. **F0.12b:** input-proof time on a phone (with and without COOP/COEP) → mobile go/no-go.
2. **Client pipeline:** the PIN is asked while the op is being opened and the challenge is computed on the client; this
   could shorten E1 and click → finalize by ≈ one inclusion [I]; worth measuring.
3. **Hot-path threshold:** p95 40.9 s; a plain transfer is a single inclusion. To be compared with the B variant in F0.11.
4. **State growth:** the dominant post-fork cost item; the slot count of the op/guess records can be reduced in the
   F0.10/F1 design.

## F0.10 · Y1 and Y2 fixes, K53, K55 (work package §7.3)

**Acceptance:**

| Criterion (§7.3) | Result |
|---|---|
| `npm test` fully green (Y1 included) | ✔ 11 files, **82 tests, 0 failures**, no crash retries [Mock] (`results/test-summary.json`, 9 November 11:41 UTC); SDK 8/8. In intermediate runs, when another job running on the machine at the same time (a video render) squeezed memory, native crashes in the alpha plugin and once a 64 MiB allocation failure in hash-wasm (Argon2id) were seen; every file also passed on its own, and the last full run was clean |
| Simulation re-run with K43 + K44 + K45 + T2 | ✔ an exact model of the contract semantics [I] (`results/pin-attack-sim.json`) |
| E7-v2 in RESULTS | ✔ exact distribution [I] + mock [Mock] (`results/e7-v2.json`) + live draws [M] |
| All contracts under 24 KiB | ✔ the largest is EncryptedAccount at 22,344 B (Round 1: 20,442) (`results/contract-sizes-f010.json`) |
| Sepolia smoke test (5 PIN + 5 hot path) | ✔ 5/5 PINs correct and executed, 5/5 hot paths executed, 0 failures; E1 p50 23.9 / p95 46.9 s; the live τ v2, K53 and K55 confirmations passed [M] |

### Decisions → code

| Decision | Implementation |
|---|---|
| **K43 + K56** score | `Track{score, decayEpoch, lastAt}`: provisional +1 on submission (I10); a correct result refunds only that +1; a correct PIN does not lower the score (I20). The back-off of the anonymous tracks is **derived** from the sum of the K-track and recovery-track scores and their shared last-attempt time; it is not stored (the old `sharedConsecutive`/`sharedNextAllowedAt` are gone). The owner's correct PIN also updates the last-attempt time. Restriction: K-track score ≥ 3 on submission → `R_STRIKES`; if the score is < 3 after the refund, the restriction lifts itself (only the score-caused bit). A PIN change/reset keeps the score; when a rotation executes, the K-track score is reset and the recovery-track score is kept. The recovery bond is tied to the recovery-track score. |
| **K44 + K54** escape lock | `startEscape` (K-only): E_addr snapshot (`escapeTo`); `escEpoch++` cancels **all** pending ops in O(1) (Evaluating, NeedsPin, Guessing, Delayed; stranger ops included); the rotation counter is reset. During an escape no new op opens (only CANCEL_ESCAPE), there are no anonymous guesses, `finalizeEvaluation` does not execute transfers and `instantTransfer` is rejected. CANCEL_ESCAPE only on the lane; cancelled ops do not come back. |
| **K45** rotation lock | Every PIN-verified ROTATE_OWNER increments `rotationsPending`; if D or a recovery helper exists, a K-track guess while the counter is > 0 gets `RotationLock`. The counter is decremented on cancellation and reset when the rotation executes (or on escape). |
| **K46** T2 | `PolicyMath.backoff`: 1–2 → 0; n ≥ 3 → 15 min·4^(n−3); n ≥ 8 → 7 days (a single function). |
| **K47** τ v2 | `D = min(L − L_min, 2^48 − 1)`, `τ = L_min + ((D·r) >> 16)`; the `max` normalization is kept. |
| **K53** challenge | `submitGuess(opId, c, handle, proof)` (three entry points); if c differs from the expected value the call reverts with `StaleChallenge` without writing anything to the counter (I23). The `OpOpened` event carries c: the client takes c from the opening receipt, so no RPC read is needed. |
| **K55** escape address | The factory/`initialize` require E_addr's EIP-712 consent (domain: account + chain; `EscapeAddress(escape, nonce)`; ERC-1271 for contract wallets). On a change (SET_ESCAPE, K+P + 30 days) the new address's consent is verified at opening; the nonce prevents replaying old consents (I24). `escapePing(issuedAt, sig)` can be relayed by anyone and updates `escapeVerifiedAt`; the watchtower reminds the owner after 90 days (`sdk/src/watchtower.ts`); staleness blocks nothing. |

### Implementation notes (decision items)

1. **Decay calendar.** The score decays by 1 at fixed 7-day boundaries counted from Unix time (not "7 days after the last attempt"). Why: since the owner's correct PIN also updates the last-attempt time, a decay tied to the last attempt would be postponed forever by an owner who uses the PIN. Cost: the attack's phase relative to the boundary can give the attacker at most one extra guess (the simulation scans all phases).
2. **Derived back-off.** The brief's rule "next allowed = last-attempt time + back-off(score)" was implemented literally. Since the score is the current (decayed) value, a decay boundary can shorten a running back-off. In the no-reaction scenario the worst case is 13 guesses in 30 days (median 12); the interim report's model, which gave 11, did not capture this. Option: store the back-off on submission (it fits the existing slot). This lowers the worst case to 12; decision in F0.14.
3. **Refund of the provisional restriction.** A correct result also undoes the `R_STRIKES` set by its own submission (`Guess.setStrikes`). Otherwise every correct PIN of the owner would re-restrict the account after UNRESTRICT while the score is ≥ 3 (`F010.test.ts` tests this). A thief's wrong guess keeps the restriction.
4. **Rotation and restriction.** A rotation resets the K-track score but does not lift `R_STRIKES`; the restriction lifts itself at the new key's first correct PIN (score 0 < 3).
5. **"Freeze" during an escape.** One-factor restrictive actions stay open: `restrict`, `guardianRestrict`, `approve(0)`, `tightenLimits`, `removeKnown`, `disable*`, `shorten*`/`lower*`. Freeze with P is closed because it runs on the (anonymous) recovery track (§7.3: "Freeze included").
6. **Opening CANCEL_ESCAPE.** No escape → `NoEscape`; no D and no recovery helper → `NotAuthorized` (I22 is visible at opening too).
7. **E_addr verification time.** When SET_ESCAPE executes, `escapeVerifiedAt` becomes the moment the consent was signed (when the op was opened). The execution time was not used, so that the 30-day delay does not hide staleness.
8. **Account retired after an escape.** After `executeEscape` the escape state persists: no new op opens, and late-arriving tokens can be swept again.
9. **Interface change.** The `submitGuess*` signatures changed (K53), `trackState`/`sharedBudget` return scores, `escapeState()` and `recoveryBond()` were added, and `getOp` shows the effective status (cancelled by an escape).

### Side findings (in the Round 1 code; fixed in F0.10) [V + Mock]

Both were found by reading the code; the first is covered by the "side finding" test in `F010.test.ts` (headroom 0 after a rotation, the new owner's 2 ETH outflow in the short class).

- **`pinCommitted` leak (low, UX).** When the key changed, the old key's pending PIN outflows could not execute, but their amounts stayed in `pinCommitted`. The new owner's later PIN outflows therefore entered the long delay class (48 h) too early. `reserved`/`pinCommitted` are now bound to a counter generation (ownerEpoch, escEpoch) and are lazily reset when the generation changes.
- **Stale cancel.** A CANCEL op (delay 0) whose key changed while its guess was in flight could still execute at finalize. It is now cancelled and the target's pause is lifted.

### Invariants and scenarios [Mock]

| Invariant | Test |
|---|---|
| I5, I6, I7, I10, I15, I18 (re-run) | `Pin`, `Recovery`, `Policy`, `Exploits` (green) |
| **I20** a correct PIN does not reset the score | `Y1.test.ts` (red in Round 1, now green: score 3 kept, the attacker gets `Backoff` until 15 min after the owner's PIN; `results/y1-f010.json`), `F010.test.ts` |
| **I21** escape: everything pending is cancelled, no anonymous guesses and no K-only ops | `F010` "I21" (5 kinds of op cancelled; `executeOp`/`finalizeEvaluation` rejected even with ok = 1; new op, Freeze and `instantTransfer` rejected; freeze actions open; counters released) |
| **I22** an escape can only be cancelled from the lane | `F010` "I22" (no D/recovery helper: cannot be cancelled, executes after 30 days; recovery helper only: cancelled from the lane), `Recovery` "escape" |
| **I23** a stale challenge is neither evaluated nor counted | `F010` "K53": correct PIN + stale c → `StaleChallenge`; score and last-attempt time unchanged; accepted with the c from the receipt |
| **I24** E_addr cannot be set or changed without consent | `F010` "K55": forged signature, signature for another account, old nonce (lost-address attack) rejected; ERC-1271 wallet accepted; ping (replay, future date and foreign signature rejected) |

| Scenario (new semantics) | Result |
|---|---|
| §11.4/1 only K stolen | restriction at the 3rd wrong guess; the owner rotates with K+P after 15 min; on an account with D the thief's next guess gets `RotationLock`; after the rotation the old K gets `NotAuthorized`, K-track score 0 |
| §11.4/3 K stolen + phone lost | freeze with P + recovery; the thief's cancel guess is wrong → the recovery continues; if the thief starts an escape, the recovery is cancelled and the funds go to E_addr |
| §11.4/4 PIN phished | the owner cancels the recovery with K+P, UNRESTRICT, PIN change; the phished PIN is now wrong |
| §11.4/5 K+P stolen, D present | the thief's 48 h transfer is cancelled with a K+D veto; the thief cannot cancel the escape without D (`BadTrack`; a forged co-signature gets `BadSignature`) |
| §11.4/10 PIN forgotten, no D/recovery helper | K alone cannot reset the PIN; the escape moves ETH + tokens to E_addr after 30 days |
| §11.4/11 you entered your own PIN wrong 3 times | the restriction stays; after 15 min you confirm UNRESTRICT with your PIN (`Pin.test.ts`; the new text for F0.14) |
| K+P stolen, no D | the owner starts an escape → the transfer is cancelled, the thief cannot cancel, 10 ETH to E_addr, 0 to the thief |
| Only K stolen → escape | every later guess of the thief is rejected; the score freezes |
| An account with D cancels the escape from the lane | old ops do not come back; new ops work normally |
| Attacker 3 wrong, owner correct PIN | the restriction stays; UNRESTRICT after 15 min; later correct PINs do not re-restrict the account |
| Owner 2 typos + correct PIN | provisional restriction on submission, lifts itself on the result (score 2) |
| Guess with a stale challenge | reverts, score unchanged |

### Attack simulation (re-run) [I] — `results/pin-attack-sim.json`

The model is an exact copy of the contract: provisional +1/refund, derived back-off, the owner's PIN updating the
last-attempt time, fixed-calendar decay (the phase is scanned on an hourly grid; the table gives the worst phase, and the
square brackets give min/median/max over phases), K44, K45 (only with D/recovery helper), the owner's lane on an account
with D. The owner's reaction time is 1 h. Success probability from the design doc v0.3 §13.8 curve.

| Semantics | Owner | 24 h | 7 days | 30 days |
|---|---|---:|---:|---:|
| Round 1, T0 | does not react | 9 (5.9%) | 15 (7.4%) | 38 (9.8%) |
| Round 1, T0 | lifts the restriction again and again | **80 (12.5%)** | **540 (19.5%)** | **2,307 (24.8%)** |
| Round 1, T0 | rotation (24 h) | 13 (7.1%) | 13 (7.1%) | 13 (7.1%) |
| **F0.10** (K43+K44+T2), no D | does not react | 8 (5.2%) | 9 (5.9%) | 13 (7.1%) [12/12/13] |
| F0.10, no D | lifts the restriction again and again | 7 (4.6%) | 8 (5.2%) | 12 (6.9%) |
| F0.10, no D | rotation (no K45) | 8 (5.2%) | 8 (5.2%) | 8 (5.2%) |
| F0.10, no D | escape | **5 (3.3%)** [4/4/5] | 5 | 5 |
| F0.10 + K45, D present | rotation | **5 (3.3%)** [4/4/5] | 5 | 5 |
| F0.10 + K45, D present | escape | 5 (3.3%) | 5 | 5 |

By reaction time (F0.10): with an escape, 15 min → 4, 1 h → 5, 8 h → 7 guesses; the same for a rotation with D. The interim
report's "4–11" range becomes **4–13** with this model (worst phase in the no-reaction case); the reason is item 2 (derived
back-off). During development, a bug that added a phantom +1 at the start of the new model was found and fixed (it is
absent from the contract: unsigned arithmetic and a 0 score). The interim report's table is kept in
`results/pin-attack-sim-interim.json`.

**Owner's cost (K43, to be written in F0.14):**

| Situation | Cost |
|---|---|
| 1–2 typos | no back-off, no restriction; the score stays at 1–2 and decays on the calendar |
| 3 typos | correct PIN after 15 min, the restriction stays; UNRESTRICT after 15 min → 30 min in total; the score drops below 3 within ≤ 7 days |
| 4 typos | 1 h + 1 h = 2 h |
| Score s after an attack | T2(s) between the owner's PINs on the K-track: 3 → 15 min, 4 → 1 h, 5 → 4 h, 6 → 16 h, 7 → 2.7 days, 8 → 7 days. Remedies: lane (D; separate score), rotation (K-track score reset), escape, decay |

### E7-v2 (K47)

**Exact distribution [I]** (all 65,536 values of r; coverage = farthest point reached / design range):

| D | v1 coverage | v2 coverage | v2 distinct values | v2 largest bucket deviation |
|---|---:|---:|---:|---:|
| 0 (and L < L_min) | τ = L_min | τ = L_min | — | — |
| 1,000 | **0.1%** (τ always L_min) | 100% | 1,000 (all) | 0.019% |
| 65,535 | **0.002%** | 100% | 65,535 (all) | 0.023% |
| 65,536 | 100% | 100% | 65,536 | 0 |
| 131,071 | **50%** | 99.999% | 65,536 | 0.011% |
| 2^20 | 99.999% | 99.999% | 65,536 | 0 |
| 2^40 | 99.998% | 99.998% | 65,536 | 0 |
| 2^50 | 99.998% | 99.998% within the design range = 25% of the full range | 65,536 | 0 |

Criterion (coverage ≥ 99% for 2^16 ≤ D < 2^48): **met**. For D ≥ 2^48, v2 stays within [L_min, L_min + 2^48) by design
(2^48 scaled units ≈ 2.8·10^8 ETH; unreachable in practice).

**Mock [Mock]:** 1,024 v2 draws for each of two values of D on TauBench; all within [L_min, L). χ² (16 buckets, df = 15,
p = 0.001 threshold 37.70): in the run stored in `results/e7-v2.json` D = 1,000 → 17.92 and D = 131,071 → 7.66. Over the six
runs whose values were recorded, D = 1,000 gave 11.5–25.0 and D = 131,071 gave 7.7–20.7, all below the threshold; since the
exact distribution is uniform within 0.02%, the variation is sampling noise. v1 gives a single value (L_min) in 16 draws at
D = 1,000. Input L < L_min → τ = L_min.

**HCU [Mock]:** per draw v1 977,032 (depth 954,000), v2 **1,127,032** (depth 1,104,000): +150,000 (one scalar `min`). The
same difference applies to account setup (setupAsset) and RESET_TRIP.

**Live [M]** (Sepolia, TauBench `0xE076A906569EF60422b31df27531CD0eA79E7146`, public decryption + KMS signature): at
D = 1,000 the offsets of 4 v2 draws were 382, 494, 793, 572; v1 draws in the same range gave 0, 0 (τ = L_min, Y2 live). At
D = 131,071 the v2 offsets were 5,291, 110,527, 28,665, 56,541; all within [L_min, L). 110,527 lies beyond the farthest point
v1 can reach (65,535). The HCU of the 4-draw transaction was 4,508,128 = 4 × 1,127,032: the same as mock and equal to the
live block meter.

### Cost and size [Mock] — `results/f010-cost-diff.json`, `results/contract-sizes-f010.json`

| Flow | Round 1 gas | F0.10 gas | Diff | HCU diff |
|---|---:|---:|---:|---:|
| factory.createAccount (+ E_addr EIP-712 consent) | 281,728 | 295,280 | +13,552 | — |
| setupAsset (τ v2) | 1,411,179 | 1,477,319 | +66,140 | +150,000 |
| requestTransfer PIN path (op opening) | 136,397 | 139,505 | +3,108 | — |
| submitGuess (outflow) | 1,206,087 | 1,205,643 | −444 | 0 |
| finalizeGuess (2 handles) | 303,015 | 311,627 | +8,612 | — |
| finalizeGuess + resetTrip (τ v2) | 881,249 | 953,642 | +72,393 | +150,000 |
| requestTransfer K-only | 1,226,772 | 1,228,302 | +1,530 | 0 |
| startEscape (snapshot slot) | 34,534 | 60,094 | +25,560 | — |

The other 17 rows are unchanged. Storage: the new fields fit into existing slots (op, track, asset, E_addr slot); the shared
budget slot is gone; the escape snapshot is 1 new slot on escape. Contract sizes (B, Round 1 → F0.10): EncryptedAccount
20,442 → 22,344, PinLib 7,217 → 8,029, PolicyLib 8,389 → 8,684, OpsLib 8,190 → 9,807, OpenLib 9,487 → 12,547, factory
1,666 → 1,868; all under 24,576.

### Sepolia smoke test [M] — `results/sepolia/{setup-f010,e1-f010,hot-path-f010,f010-live,f010-smoke}.json`

- **Deployment:** the F0.10 build (`results/sepolia/f010/build.json`), 7 contracts, 104,443,293 gas in total. EncryptedAccount
  `0x818E0877c0b7Aef5f9Ba80713a598b24490155b8`, factory `0x2c65eAdA66f66b0b03ba3207293F7EAA316f47D3`. The F0.9 baseline
  was not touched (`SEP_RUN=f010`: separate state and output files).
- **Accounts:** e1 `0x7F8c5399705560b125D62C02860d7A09987Cc9a0` and hot `0x34318C950d350cb236409AC934398cD4EAbE2FcB`;
  setup 17.05M gas per account (F0.9: 17.03M), 1,424,064 HCU (+150,000, τ v2). E_addr = watchtower wallet; the EIP-712
  consent was accepted live (`escapeState`: nonce 1, verification time = setup time).

| Flow (n = 5) | p50 | p95 | max | F0.9 baseline (n = 30) p50 / p95 |
|---|---:|---:|---:|---:|
| PIN flow (E1) | 23.9 s | 46.9 s | 46.9 s | 24.4 / 47.7 s |
| K-only hot path | 28.5 s | 37.0 s | 37.0 s | 19.9 / 40.9 s |

- All 5 PIN samples were correct and executed, and all 5 hot-path samples executed (no failures). The challenge was taken
  from the opening receipt (K53): challenge step 0 ms (in F0.9 an RPC read, p50 103 ms).
- The hot path's p50 difference comes from the network: inclusion of the watchtower's `finalizeEvaluation` p50 12.4 s
  (F0.9: 5.0 s); the request and decryption steps are at the baseline level. Contract gas +0.1%. With n = 5 the tail is not
  interpreted; the E1 decision rests on F0.9.

| Live gas (p50) | F0.9 (Round 1) | F0.10 | Diff | Mock diff |
|---|---:|---:|---:|---:|
| op opening (PIN path) | 490,253 | 493,361 | +3,108 | +3,108 |
| submitGuess | 1,711,020 | **1,605,512** | **−105,508** | −444 |
| finalizeGuess | 526,028 | 541,456 | +15,428 | +8,612 |
| executeOp | 765,223 | 768,149 | +2,926 | +2,926 |
| K-only request | 1,524,305 | 1,525,835 | +1,530 | +1,530 |
| finalizeEvaluation | 422,803 | 423,646 | +843 | +867 |

  submitGuess got cheaper live because of the post-fork gas schedule: in Round 1 every success reset the track slot and the
  shared budget slot, and the next guess rewrote them at the "new slot" price (≈ 111k gas). In F0.10 there is no shared slot
  and the track slot does not return to zero (`lastAt` and `decayEpoch` stay). ≈ −84k gas net on a PIN transfer (a small
  contribution to state growth, the subject of F0.15).
- HCU live meter checks: PIN flow 20/20 equal; hot path 9 equal, 1 unreadable (RPC).
- **K53 live:** the c in the receipt = the c on chain; a `submitGuess` eth_call with a stale c read from the block before
  the op appeared → `StaleChallenge`.
- **K55 live:** a factory eth_call with a consent signed by a key other than E_addr → `BadSignature`.
- **Budget:** F0.10 ≈ 0.0090 Sepolia ETH (user 0.0086 + watchtower 0.0005). Remaining: user 0.0633, watchtower 0.0091 ETH.

### Limits

- Simulation [I]: the attacker uses only the K-track (the recovery track is bonded and shares the common budget); the
  success curve is interpolated from the design doc v0.3 §13.8 data. The owner's reaction time is fixed in the model.
- Smoke test with a small sample (n = 5); the E1 decision rests on F0.9's n = 30 measurement.
- Lazy cancellation on escape: the raw stored status of pending ops does not change; the effective status is applied in
  `getOp` and in every entry point (indexers should use `EscapeStarted.escEpoch`).

### F0.10 addendum (work package §8.3) [Mock]

**Acceptance:** `npm test` 11 files, **87 tests, 0 failures**, no crash retries (9 November 12:36 UTC); all contracts under
24 KiB (EncryptedAccount 22,369, OpenLib 12,736, OpsLib 10,262, PinLib 8,198 B); I20–I24 re-run (`F010.test.ts`,
`Y1.test.ts`).

1. **E_addr ≠ watchtower (5.7):** checked at setup (`initialize`), at the opening and execution of SET_ESCAPE, and at the
   opening and execution of SET_GUARDIAN (removing the watchtower, i.e. setting 0, is allowed). **Same pattern, addition:**
   since Round 1 a rotation or a recovery could make the new key E_addr (whoever steals K would then also get the escape
   address); E_addr ≠ K is now checked on rotation and recovery as well (at opening and at execution). Of two conflicting
   pending ops (SET_ESCAPE(X) after SET_GUARDIAN(X) executed; recovery(X) after E_addr was switched to X) the second does
   not execute but is **cancelled** — it does not revert, because it can also run inside a finalize; a cancelled rotation
   releases the K45 counter.
2. **Re-setting the restriction (5.3):** a wrong K-track result re-sets the restriction if the K-track score is ≥ 3 and
   `R_STRIKES` has been lifted at that moment. The scope is the K-track only: a typo on the lane (K + D + P) or a bonded
   stranger's guess on the recovery track does not re-restrict the account (a stranger paying a bond to close the owner's
   K-only path would be a harassment route). **The "single pending guess" rule is per track:** the K-track, the recovery
   track and the lane have separate slots, so at most 3 guesses can be pending on an account at once. Since two K-track
   guesses cannot be pending at the same time, concurrency is between the K-track and the lane (or the recovery track).
   Test: while the thief's 4th wrong guess is in flight on the K-track, the owner confirms UNRESTRICT on the lane → the
   restriction lifts → it is re-set when the wrong result arrives (without the addendum the account would stay
   unrestricted).
3. **Open approvals on escape (5.5):** the watchtower SDK tracks (token, spender) pairs from the account's approval ops and
   from the `Approval` events of the watched ERC-20s (including non-op paths such as permit signatures); on
   `EscapeStarted` it reports the ones still open as `open-approval` and suggests `requestApprove(token, spender, 0)`
   (K-only, also open during an escape). 7984 operator revocation comes in Phase 2; batch revocation (`revokeAll`) is an
   F1 note.

Note: on the Sepolia accounts of the smoke test E_addr = watchtower (earlier build); the new rule rejects this. Later
Sepolia accounts use separate addresses for the watchtower and E_addr.

## F0.11 · B variant: synchronous hot path in open mode (work package §4 F0.11, §8.4)

**Acceptance:** the A/B table is below (gas, end-to-end time, setup cost, what stays hidden, what is lost against which
attack). I1, I2, I11, I12, I16 and I17 are green with B semantics (`test/F011.test.ts`, 11 tests); `npm test` 12 files
**98/98**, SDK 8/8; all contracts under 24 KiB (EncryptedAccountB 23,481 B, EncryptedAccount 22,315 B). On Sepolia A and B
were measured with the same build, to the same recipient, with the same amount, as N = 30 interleaved pairs. **In B,
addresses added by hand and never used are also visible on chain** (below, "What stays hidden").

- **What:** B is a separate implementation next to A (`EncryptedAccountB`); A is unchanged. The policy mode is chosen at
  setup, by the factory the account is cloned from.
- **Result [M]:** on Sepolia a K-only transfer is one transaction in B: p50 7.2 / p95 14.6 s, 59,820 gas, 0 HCU. In A it is
  two transactions and one KMS decryption: p50 20.1 / p95 26.3 s, 1,949,477 gas (**32.6×**). Setup costs 17.0M gas in A
  and 3.3M in B (5.2×).
- **Cost of B [V]:** the lists (including entries added by hand and never used), the list size, the limit and the epoch
  spending are public; there is no random tripwire. If B's limit is set equal to A's L_min, the maximum a thief can take
  per epoch does not grow; what is lost is uncertainty, the alarm on probing, and the privacy of the lists (interpretation
  item 1).
- **Recommendation (open decision):** B as the default for human accounts in open mode, A as the "hidden rules" option;
  private mode and agent accounts stay on A (see "Open decisions" below).

### Definition → code [V]

| Definition (work package) | Code |
|---|---|
| Separate build, A stays | `contracts/account/EncryptedAccountB.sol` inherits from A. A only gained `virtual` markers and the `_openMode()` hook (same behavior; the 87 earlier tests pass unchanged). B's storage was appended to the end of the layout (`openMode`, `openKnownR/S`, `AssetCfg.openLimit`): A's slots did not move |
| The policy mode is chosen at setup | The mode is fixed by the implementation the account is cloned from: a second `EncryptedAccountFactory` clones the B implementation. Private mode and agent accounts stay on A; B is only for human accounts in open mode |
| Lists and epoch limit public | `openKnownR/S[address]` = activation time (0 = not on the list); `openLimit` per asset, K-only outflows count in `spent`; `OpenKnownChanged` and `OpenLimitSet` events |
| Listed and within the limit → one transaction, synchronous | `requestTransfer` / `requestApprove`: all conditions are public (listed, within the limit, not restricted, pulse valid, not an unlimited approval) → `spent += amount`, `OpenOutflow` event, the transfer in the same transaction. No op is opened, no FHE call |
| Over the limit or unknown → PIN path, unchanged | The same call opens A's PIN op via `OpenLib.openOutflow(viaPin = true)`; PinLib, execution and the L_big delay class are the same code as in A |
| Adding with K+P or after the first PIN-verified send, removing with K only | `openAdmin(ADD_KNOWN_R/S, address)` → PIN + `knownAdd` delay. When a PIN-verified outflow executes and `autoKnown` is on, the recipient joins the list (written without FHE). `removeKnownOpen`: K-only, immediate |
| Changing the limit | Lowering K-only, immediate (`lowerOpenLimit`); raising K+P (`SET_OPEN_LIMIT` = 20, loosen delay) |
| The watchtower reports every K-only transfer | SDK: `open-outflow` and `known-changed` alerts; approvals given on the K-only path join the `open-approval` list on escape |

### Invariants with B semantics [Mock] — `test/F011.test.ts`

| Invariant (design doc v0.3 §32) | Meaning in B and test |
|---|---|
| **I1** without P verified, no transfer to an unlisted recipient executes | A K-only request to a recipient that is not on the public list opens a PIN op; the money goes only after PIN + delay. The first PIN-verified send adds the recipient to the list; the next K-only transfer to that recipient is one transaction |
| **I2** without P verified, no outflow above the limit executes; above L_big it waits long | A request that exceeds the public limit by 1 base unit goes to the PIN path. A PIN outflow above L_big gets the `bigTransfer` delay (the PIN path is unchanged) |
| **I11** with K alone only allowed patterns | A plain transfer (ETH, ERC-20) to a listed recipient and a limited approval to a listed spender run in one transaction. An unlimited approval, an approval to an address on the recipient list and a transfer to a spender need the PIN; a generic call needs K+P as in A |
| **I12** `spent` never exceeds the threshold, no input can lower the counter | Up to exactly the limit passes, one unit more goes to the PIN path. A PIN outflow does not change `spent` (it counts in `pinSpent`); only the epoch roll resets the counter |
| **I16** every potential outflow counts against the same limit | 200 USDC approval + 300 USDC transfer = the 500 USDC limit; the next transfer and approval go to the PIN path |
| **I17** additions only with a PIN-verified op or K+P; K alone can only remove | The ADD_KNOWN op needs the PIN and a 24 h delay. K removes immediately; a non-K caller cannot remove. With `autoKnown` off a PIN-verified send does not add to the list. A's encrypted list entry points are closed in B; the public list form does not exist on an A account |
| I18, I21, pulse | In restricted mode and when the pulse has expired, a K-only request goes to the PIN path; during an escape it reverts with `EscapeActive`; `approve(0)` also works during an escape |
| Extra | The public limit can be lowered with K alone, raising it needs K+P + 72 h; the watchtower reports every K-only outflow and every list change |

`npm test`: 12 files, 98 tests, green in a single run, no crash retries (`results/test-summary.json`). In an earlier run the
AA file could not allocate Argon2id's 64 MiB because of memory pressure on the machine (`RangeError`); unrelated to the
code, it passed once memory was free.

### A/B table [M + Mock] — `node scripts/f011-results.mjs` → `results/f011-summary.json`

| | A (encrypted policy) | B (public list, public limit) | Difference |
|---|---|---|---|
| K-only end-to-end time, Sepolia p50 / p95 [M] (n = 30 / 30) | 20.1 / 26.3 s | 7.2 / 14.6 s | p50 2.8×, p95 1.8× shorter |
| Number of transactions | 2 (request + the watchtower's finalize) and one KMS decryption | 1 | — |
| Gas, Sepolia p50 [M] | 1,525,835 + 423,646 = 1,949,477 | 59,820 | 32.6× |
| HCU (request) [M] | 774,036 | 0 (0 FHE events) | — |
| Gas, mock (warm, ERC-20) [Mock] | 1,516,768 | 61,662 (plain ERC-20 transfer 51,255) | 24.6× |
| Setup gas, mock [Mock] (2 assets; B: 3 recipients + 1 spender) | 11,234,726 | 2,314,579 | 4.9× |
| Setup gas, Sepolia [M] (ETH; B: 1 recipient) | 17,048,629 | 3,259,034 | 5.2× |
| Per list entry | — (30 + 10 fixed slots, count hidden) | mock 25,235 · Sepolia single-entry `setupKnownOpen` 136,692 | — |
| K-only path during a Zama KMS / relayer outage | Stops | Works | — |
| What stays hidden | Lists (except auto-added entries), list size, limit, τ, PIN | Only PIN, L_big, duress | Below |

### What stays hidden, what is lost [V + I]

| Information | A | B |
|---|---|---|
| Contents of the known recipient / spender lists | Hidden: 30 + 10 encrypted slots (recipients auto-added after a PIN-verified send are traceable on chain) | **Public:** every entry in the `OpenKnownChanged` event and the `openKnown` view. **Addresses added by hand and never used are also visible on chain** (in the test, all three manually added recipients were read from the events) |
| List size | Hidden (empty slots are encrypted zeros too) | Public |
| K-only limit and epoch spending | Hidden: L_min, L; `spent` is public but the threshold is unknown | **Public:** `openLimit` and `spent` |
| Random tripwire τ | Present: nobody knows it; an attempt above it trips a sticky tripwire and a silent alarm to the watchtower | **None** |
| `ok` bits | Accumulate information about the threshold over time | Not needed (every condition is public anyway) |
| PIN fingerprint, duress, L_big | Encrypted | Encrypted, same code (the PIN path is unchanged) |
| Amount and recipient of an executed transfer | Public (open mode) | Public (open mode) |

| Attack / situation | A | B | Difference |
|---|---|---|---|
| Only K stolen (no P) | The thief can send to known recipients up to τ but does not know τ; an attempt above it trips the tripwire and the watchtower restricts the account | The thief knows the list and `openLimit − spent` exactly, and sends the whole limit per epoch to the listed addresses without risk. The watchtower reports every transfer immediately (the owner restricts or starts an escape) | Uncertainty and the tripwire are lost. The worst-case loss per epoch is `openLimit` (in A the unknown τ < L). In both, the thief cannot send to an address of his own |
| Reconnaissance and social engineering | Lists not visible | The owner's counterparties (exchange deposit addresses, people), budget and spending pattern are public: ready data for targeted phishing and look-alike addresses (address poisoning) | Loss of privacy |
| A listed counterparty is malicious or compromised | A K thief can send up to τ there | The same, up to the limit and knowing it exactly | Small |
| Zama KMS / relayer outage | The K-only path stops (finalize needs a decryption); the PIN path stops; only the escape works | **The K-only path keeps working** (no FHE); the PIN path stops as in A | In B's favor (availability) |
| HCU block limit, coprocessor load | Spends HCU per request | 0 HCU | In B's favor |
| Private mode and agent accounts | A | Not applicable (they stay on A, work package §4 F0.11) | — |

### Sepolia measurement [M] — `results/sepolia/{setup-f011,f011-ab}.json`

- **Deployment:** the F0.11 build (`results/sepolia/f011/build.json`), 8 contracts, 141,570,189 gas (≈ 0.0071 ETH):
  EncryptedAccount `0x97181fF14005aEA66f38175d791d10980300De70`, EncryptedAccountB
  `0x00C6b3Ffe57752BD9c42821A05ce52D23DE3CCe0`, factory A `0xd1A9660B0365D86096E4982e992b7258d0A57EdA`, factory B
  `0xe1738E23DCD165BC138FdD4714aC5839d6C09129`. Writing code is expensive on the new gas schedule: the libraries cost
  12.9–20.3M, the account implementations 34.8M and 36.6M gas.
- **Accounts:** A `0xF681AE76D3c1c5A9137f9b3DF1bC0fcBEC3aECB3`, B `0x21f09Ba39694Dd7A1c242631234F689127381b89`. The
  guardian is the watchtower; E_addr is a temporary wallet per account (role separation, F0.10 addendum); test delays as
  in F0.9.

| Setup step | A | B |
|---|---|---|
| createAccount | 1,306,836 | 1,417,034 (separate `openMode` slot, see "Limits") |
| setupPin | 842,263 (79,000 HCU) | 842,315 (79,000 HCU) |
| setupAsset / setupAssetOpen (ETH) | 1,959,205 (1,345,064 HCU) | 799,370 |
| Known lists | 12,843,456 (4 transactions, 30 + 10 encrypted slots) | 136,692 (1 public entry) |
| setupRoles + arm | 96,869 | 63,623 |
| **Total** | **17,048,629** | **3,259,034** |

- **A/B run:** N = 30 pairs, 18:04–18:31 UTC; interleaved, random order within each pair, 3–20 s pauses in between. Same
  recipient (`0xcaC004eC1B4ca48EB568c4E903F05ADaA19eF083`), same amount (1e12 wei); all 60 samples executed, 0 failures.

| | A | B |
|---|---|---|
| End-to-end p50 / p95 / max | 20.1 / 26.3 / 31.5 s | 7.2 / 14.6 / 24.4 s |
| Breakdown (p50) | request 7.9 · decryption 7.2 · finalize 4.7 s | single transaction |
| Inclusion | request 1 block (p95 2); finalize 1 block after the request | 1 block (p95 2) |
| Gas | 1,525,835 + 423,646 = 1,949,477 (the same values as in F0.10) | 59,820 (identical in every sample) |
| HCU | request 774,036; equal to the live block meter in 56 readings, 4 unreadable | 0, 0 FHE events |
| Distribution | 15–20 s: 14 · 20–25: 12 · 25–30: 3 · 30–35: 1 | 0–5 s: 7 · 5–10: 15 · 10–15: 7 · 20–25: 1 |

- **Reading:** B's time equals one inclusion and spreads between 2 and 14 s depending on where in the 12 s slot the
  transaction was sent (the single outlier, 24.4 s, missed a block). A's time is two inclusions plus a ≈ 7 s KMS
  decryption. Since the samples were interleaved, both variants saw the same network conditions. Network conditions vary
  from run to run: A's p95 was 26.3 s in this run and 40.9 s in F0.9.
- **Warm-up (not part of the measurement):** opening the recipient account cost 204,600 gas (new-account surcharge); B's
  first K-only transfer 172,248 gas (the `spent` slot is opened); A's 2,159,841 gas.
- **Budget:** preparation ≈ 0.0086 ETH, samples 0.0030 ETH. Remaining: burner 0.0523, watchtower 0.0084 Sepolia ETH.

### Interpretation [I]

1. **If B's limit is set equal to A's L_min, the worst-case loss does not grow.** In A the owner's app already routes
   amounts above L_min straight to the PIN path (so as never to trip the tripwire), so the owner's practical PIN-free
   headroom is L_min in A as well. A's range τ ∈ [L_min, L) works against the thief, not for the owner: a thief who does not
   know L_min trips the tripwire when he exceeds τ, and the watchtower restricts the account. In B the thief knows
   `openLimit` and never trips, but the most he can take per epoch is L_min (in A, τ ≥ L_min). What is lost is not the cap
   but uncertainty, the alarm on probing, and the privacy of the lists.
2. **The marginal value of privacy in open mode is limited.** In open mode the recipient and amount of every executed
   transfer are visible anyway; in A the auto-added recipients are traceable on chain too. What B additionally reveals:
   entries added by hand and never used, the list size, the "trusted" label and the exact budget.
3. **B makes daily payments independent of Zama.** During a KMS or relayer outage A's K-only path stops (`ok` cannot be
   decrypted); B's keeps working. The PIN path needs FHE in both.
4. **The cost difference comes from state growth, not from FHE.** A's request writes many new slots and ACL permissions for
   the op record and the FHE evaluation; B updates a single counter. When F0.15 reduces A's slot count, the gap narrows but
   does not close.

### Limits

- On Sepolia's new gas schedule a new slot costs ≈ 111k gas (mainnet ≈ 22k): every list entry in B is a new slot. A's
  30 + 10 encrypted slots are a fixed cost and hide the count.
- In B the `openMode` flag sits in a separate slot (so that A's layout does not move): creating a B account costs ≈ 110k
  gas more on Sepolia (1,417,034 against 1,306,836). Packing the flag into the flags slot removes the difference → note
  for F0.15 (done in F0.15: the flag now sits in the flags slot).
- A B request that falls through to the PIN path first reads the public conditions, so it costs ≈ 27k gas more than A's
  PIN op opening (mock 186,804 against 159,621).
- B's first K-only transfer of an asset opens the `spent` slot (Sepolia warm-up 172,248 gas); later ones cost the value
  measured here. For ERC-20 it is 61,662 gas on the mock, ≈ 10k above a plain ERC-20 transfer (51,255).
- The ERC-4337 (UserOp) path was not measured separately for B: `validateUserOp` is unchanged; the same call runs inside a
  UserOp.
- The measurement used a single recipient and ETH (F0.9 method); ERC-20 and approvals were measured on the mock.

### Open decisions

1. **Default in open mode.** Recommendation: **B as the default** for human accounts in open mode, A as an option (the
   "hidden rules" mode). Private mode and agent accounts stay on A. Rationale: in open mode transfers are visible anyway
   (interpretation 2); for daily payments the cost and time difference is large; B makes daily payments independent of
   Zama (interpretation 3); if the limit is set equal to L_min the worst-case loss does not grow (interpretation 1). It
   also fits a positioning as the account and security layer for confidential assets. Counter-argument: the product's
   distinguishing promise is "hidden rules"; in open mode B reduces it to PIN, escape and recovery, and the rest resembles
   a spending-limit module.
2. **Setup screen wording (if B is chosen).** It must say plainly: "Your list and your daily limit become public; addresses
   you add to the list but never use are visible too."
3. **Addition to F0.15.** B's `openMode` flag slot (above) and A's slots that are reset and rewritten on every request.
   Both done in F0.15 (see that section).

## F0.12 · Mobile Argon2id measurement (E17)

- **Page:** `bench/argon2id.html` (built with `node bench/build.mjs`) — a single file that needs no network (77 KB; hash-wasm 4.13.0 argon2 + sha256 embedded;
  built with `node bench/build.mjs`). v1 (64 MiB, t=3) and extra sets (32 MiB t=3, 64 MiB t=2, 128 MiB t=2), 20 runs + 1
  warm-up per set; p50/p95/min/max; runs that went to the background are excluded; memory errors and page crashes (on
  reload) are recorded; user agent and (in Chrome) device model; "Copy JSON".
- **Correctness:** before every measurement the reference KAT (`password`/`somesalt`, t=2) and the v1 pipeline (salt + NFKC
  + Argon2id + fingerprint) are compared with the Sepolia vector; on a mismatch the measurement stops.
- **Desktop smoke test [M]** (the development machine, an embedded Chromium browser, n = 5): KAT ✔, pipeline ✔, v1 p50
  172 ms / p95 174 ms (consistent with the Node measurement: 180/186 ms).
- **Android measurement [M]** (8 November, 22:13 UTC): Samsung Galaxy A73 5G (model code SM-A736B), Android 15, Chrome
  156, 8 cores, 8 GB. The page was opened as a local file (`crossOriginIsolated = false`). KAT ✔, v1 pipeline ✔ (fingerprint
  identical to the Sepolia vector of that time: `0xfd60401df3f239b8`; the salt domain string was renamed before
  publication, so today's vectors differ, while the KDF parameters and the timings are unchanged); 0 runs went to the background, 0 memory errors. Raw output:
  `results/argon2id-mobile.json`.

| Set | p50 | p95 | min | max | Desktop p95 (Chromium) |
|---|---:|---:|---:|---:|---:|
| **v1 · 64 MiB, t = 3** | 308.6 ms | **321.6 ms** | 301.5 ms | 323.7 ms | 174 ms (phone 1.85×) |
| 32 MiB, t = 3 | 159.3 ms | 164.4 ms | 148.5 ms | 165.9 ms | — |
| 64 MiB, t = 2 | 219.5 ms | 230.6 ms | 209.7 ms | 230.9 ms | — |
| 128 MiB, t = 2 | 440.5 ms | 454.9 ms | 424.7 ms | 458.7 ms | — |

- **Preliminary recommendation (iOS pending):**
  - **v1 stays** (64 MiB, t = 3, p = 1): p95 321.6 ms on a mid-range Android phone, about a third of the target (≤ 1 s). The
    design doc v0.3 §13.1 estimate of "0.5–1 s on a phone" was conservative.
  - 128 MiB, t = 2 is also below the target (p95 455 ms) and raises the attacker's cost per guess by roughly 1.3× (m·t: 256
    against 192 MiB·passes) [I]. But against offline brute force over the 10^6 space of a 6-digit PIN this gain is small;
    once the KMS threshold is breached, what really protects the PIN is its length (K18), not the Argon2 parameter [I].
    With low-RAM devices and the iOS WASM memory limits still unknown, an upgrade is not recommended; to be revisited when
    the iOS result arrives.
  - **Effect on E1:** Argon2id takes ≈ 0.3 s on a phone, i.e. ≈ 1% of the E1 total. The main uncertainty of mobile E1 is the
    encrypted input proof: this page opened with `crossOriginIsolated = false`; on a normal web page without COOP/COEP
    headers the TFHE WASM of `@fhevm/sdk` falls back to a single thread (the F0.9 side experiment `enc-threads` measures the
    difference on desktop). Recommended extra measurement: add input-proof generation to the same page (F0.12b).
- **Acceptance:** Android ✔ · iOS ✘ for now: as of 8 November there is no iPhone to measure on; open item. The preliminary
  recommendation will be re-evaluated when the iOS result arrives (on iOS the main risk is WASM memory limits rather than
  speed [I]).

## F0.12b · Input proof on a phone (mobile gate, K58)

**Decision (§7.4): mobile web GO.** On the Galaxy A73 without COOP/COEP (single thread, worst case) the local proof of a
single `euint64` input has p95 **13.65 s** ≤ 16 s [M]. Mobile E1 estimate p50 ≈ 33.9 s, p95 ≈ **57.0 s** [I] — margin to
the criterion ≈ 3 s, tight. Recommendations: serve the production page with COOP/COEP (not required, it widens the
margin); download and store the CRS before the PIN is asked.

| Galaxy A73 5G (Android 15, Chrome 156) · single file, crossOriginIsolated = false | p50 | p95 | max |
|---|---:|---:|---:|
| Local proof (single `euint64`, n = 10) | 13.48 s | **13.65 s** | 13.65 s |
| Relayer | 0.87 s | 0.99 s | 0.99 s |
| Total encryption | 14.39 s | 14.56 s | 14.56 s |
| 12 `eaddress` (local, n = 2) | 14.61 / 14.65 s | | |

- Single-threaded, the phone is 1.46× slower than the desktop (p50 13.48 against 9.21 s). The results are very consistent
  (local 13.32–13.65 s). Raw output: `results/proof-bench/phone-galaxy-a73-plain-file-2026-11-09T05-10-07-337Z.json`;
  summary and decision: `results/mobile-proof.json`.
- **First load (phone) [M]:** client ready in 10.8 s (CRS 4.57 MB download in 8.7 s), first encryption 15.4 s; ≈ 26 s in
  total is added to the session's first PIN operation. This disappears if the CRS is downloaded in advance [I].
- **Still open (not needed for the decision):** `/coi/` on the phone (the multithreading gain on the phone; needs a server
  with COOP/COEP) and iOS Safari (when a device is available).

### Preparation and desktop reference

- **Pages ready:** `bench/proof/` (`node bench/proof/build.mjs`; `@fhevm/sdk` 0.13.7 browser bundle 2.78 MB, TFHE 1.6.2
  with embedded WASM and worker). `/coi/` with COOP/COEP headers, `/plain/` without; the headers come from `vercel.json`
  and `_headers`, locally from `bench/proof/serve.mjs`. Measured: first load (TFHE init, public key + CRS download, first
  encryption), a single `euint64` input n = 10 (5 s apart), reference 12 `eaddress` × 2; runs that went to the background
  are excluded.
- **Desktop reference [M]** (Ryzen 5 5600, Chromium 152, localhost; `results/proof-bench/*.json`,
  `results/mobile-proof.json`):

| Page | TFHE threads | Local proof p50 | p95 | 12 eaddress (local) |
|---|---:|---:|---:|---:|
| `/coi/` (crossOriginIsolated) | 12 | 4.06 s | 4.10 s | 4.2 s |
| `/plain/` | 0 (single) | 9.21 s | 9.41 s | 9.9 s |

- **First load [M]:** CRS 4.57 MB, public key 33 KB. With a cold cache the client is ready in **38.8 s** (CRS download
  37.6 s); with a warm cache in 0.7–1.1 s (the CRS comes from the browser's HTTP cache). The app should download and store
  the CRS before a PIN is needed [I].
- **Observation [M]:** the proof of a 12-`eaddress` input is only ≈ 4–7% longer than that of a single `euint64`; the proof
  time is determined by the proof capacity (2048-bit CRS) rather than by the number of values [I].
- The phone measurement used the single-file, header-less build (built into `bench/proof/dist/` by `node bench/proof/build.mjs`, opened on the phone as a file,
  like the Argon2id page). A page opened from a file has the origin "null"; the relayer accepts the `null` origin, S3 and
  the RPC accept `*` (CORS verified).

## F0.15 · State growth: fewer new slots (work package §7.5, §8.4)

On Sepolia's current gas schedule, a storage slot that goes from zero to nonzero costs 110,983 gas; on mainnet today
it costs 22,445 (`results/sepolia/gas-schedule*.json`) [M]. On Sepolia, most of a flow's cost therefore comes from the
state it creates, not from FHE.

**Result:**

- Under F0.15, a PIN-verified ETH transfer opens **8 new slots instead of 16** on Sepolia [M]. The account's own slots
  drop from 11 to 3 (the op record); the other five are ACL entries that must be persistent.
- Gas on Sepolia: **−22.6%** for the PIN transfer and −10.2% for the K-only transfer. On today's mainnet schedule this
  is −3.5% and −1.9% [I].
- The day's first transfer no longer re-creates the daily counter slot (step 2): −86k gas per day-first transfer on
  Sepolia, about neutral on today's mainnet schedule [M + I].
- The stored back-off (§5.2 b) is in place. 30-day worst case: 13 → 12 guesses without a reaction, 5 → 4 with an escape
  within an hour [I].
- `npm test` 101/101 (98 + 3 new). The contracts stay under 24 KiB (A 22,505 B, B 23,666 B).
- Acceptance (§7.5, "at least halved"): **met**.

### Where each new slot comes from [M] — `results/sepolia/f015-slots.json`

`scripts/sepolia/f015-slots.ts` reads the block access list (EIP-7928, `eth_getBlockAccessList`) of every transaction in
the F0.10 run and the F0.15 run. For each slot it takes the value before the transaction: an earlier write in the same
block, otherwise `eth_getStorageAt` at block − 1. It then counts zero → nonzero writes per address.

Both runs use the same method (`f09-run.ts`, N = 5): same account setup, test delays, limits and amount. The PIN
transfer goes to a fresh address each time; the K-only transfer goes to a known recipient. An account's first sample
also opens one-time slots, so the tables use samples 2–5 (medians). The counts were identical in all four samples of
each run. The first samples are in the JSON (F0.15: 16 on the PIN path, 9 on the K-only path).

**PIN-verified ETH transfer**

| Step | Record | F0.10 | F0.15 | How |
|---|---|---:|---:|---|
| `requestTransfer` | op record: type / status / epochs, recipient, amount | 3 | 3 | stays: the op's content must survive until it executes |
| | op content hash | 1 | 0 | recomputed from the op's fields |
| `submitGuess` | guess record (`ok`, `big`, `isDuress` handles, flags) | 4 | 0 | one record per track, overwritten by each guess |
| | the track's pending op | 1 | 0 | packed with the score into one slot that stays nonzero |
| | `usedInput[handle]` | 1 | 0 | a last-input field in the track's record (I5 per track) |
| | ACL: `ok` and `big` public; `isDuress` for the account and the guardian | 4 | 4 | required (see Limits) |
| `finalizeGuess` | `pinCommitted` | 1 | 0 | shares a slot with `unit` |
| `executeOp` | ACL: the auto-added known-list entry | 1 | 1 | required (a stored handle) |
| | new account (the recipient is a fresh address, by design of the run) | 1 | 1 | — |
| **Total** | | **16 + 1 account** | **8 + 1 account** | |

**K-only ETH transfer**

| Step | Record | F0.10 | F0.15 |
|---|---|---:|---:|
| `requestTransfer` | op record (3 slots) + `ok` handle in the op | 4 | 4 |
| | op content hash | 1 | 0 |
| | `reserved` (now shares a slot with `configured`) | 1 | 0 |
| | ACL: `ok` public; `tripped` for the account and the guardian | 3 | 3 |
| `finalizeEvaluation` | — | 0 | 0 |
| **Total** | | **9** | **7** |

### Cost on both gas schedules [M + I]

Sepolia figures are medians of the steady samples [M]. "Today's mainnet" is estimated as live gas − new slots ×
(110,983 − 22,445) − new accounts × (186,391 − 25,000) [I] (the method of the F0.9 cost model).

| Flow (steady) | Sepolia F0.10 | Sepolia F0.15 | Δ | Today's mainnet F0.10 | F0.15 | Δ |
|---|---:|---:|---:|---:|---:|---:|
| PIN transfer (request + guess + finalize + execute) | 3,408,470 | **2,636,875** | **−22.6%** | 1,830,471 | 1,767,180 | −3.5% |
| K-only transfer (request + finalize) | 1,949,481 | **1,750,433** | **−10.2%** | 1,152,639 | 1,130,667 | −1.9% |

Per step on Sepolia (PIN transfer):

| Step | F0.10 gas | F0.15 gas | Δ |
|---|---:|---:|---:|
| `requestTransfer` | 493,361 | 383,700 | −109,661 (one slot) |
| `submitGuess` | 1,605,508 | 1,014,339 | −591,169 (six slots) |
| `finalizeGuess` | 541,456 | 458,800 | −82,656 |
| `executeOp` | 768,145 | 780,036 | +11,891 |

`executeOp` and `finalizeEvaluation` cost slightly more: the slots they used to clear, and get a refund for, now stay
nonzero. That refund was smaller than the cost of re-creating those slots in the next flow.

- **Mock [Mock]** (Hardhat, mainnet-like schedule; `test/CostModel.test.ts`; `results/f015-cost-diff.json`):
  - PIN transfer, an account's first: −40.7k gas (`requestTransfer` −21.7k, `submitGuess` −13.5k, `finalizeGuess`
    −8.4k, `executeOp` +2.9k).
  - A second guess on the same track: −76.0k, because the guess record is reused.
  - K-only: `requestTransfer` −43.1k, `finalizeEvaluation` +3.1k.
  - HCU is unchanged in every flow.
  - The test now starts 10 minutes into an epoch. The Hardhat chain starts from the wall clock, and a run just before
    UTC midnight had measured an epoch roll inside the flow (+10k in `executeOp`).
- **Latency [M]** (F0.15 run, n = 5): E1 p50 24.3 s / p95 24.3 s (F0.10: 23.9 / 46.9 s); K-only p50 20.8 / p95 25.4 s.
  The storage changes do not affect latency; inclusion and decryption dominate.

### Step 2: epoch counters that restart at 1 [M + Mock]

The daily counters (`spent`, `pinSpent`, `instantSpent`) used to be set to zero when the epoch rolled. So the day's
first transfer of each asset re-created a slot: once for the K-only path, once for the PIN path. For an owner who makes
one or two transfers a day, that is almost every transfer. This is the reset-and-rewrite pattern that §8.4 asks to
remove.

Change: once a counter has been used, it is stored as value + 1. The epoch roll writes 1 (value 0) instead of 0
(`PolicyMath.counterOf` / `counterAdd`); views and events return the value.

- **Mock [Mock]:** `Policy.test.ts` reads the raw slot. After the epoch roll it holds 1 (never 0) and `assetState`
  returns 0; after the day's first transfer it holds amount + 1.
- **Sepolia [M]:** one sample per build right after the UTC epoch change (10 November, from 00:01 UTC; run files
  `e1-f015.json` #6, `e1-f015b.json` #4 and the matching hot-path files).
  - The old build (`f015`) re-creates the counter slot on the day's first transfer: `pinSpent` in `executeOp` (877,956
    gas against 780,036 in steady state) and `spent` in `finalizeEvaluation` (531,438 against 433,530).
  - The new build (`f015b`) does not: both steps cost their steady-state gas (780,060 and 433,563).
  - Per day-first transfer on Sepolia: PIN 9 → 8 new slots, 2,747,707 → 2,661,663 gas (−86.0k, −3.1%); K-only 8 → 7,
    1,851,233 → 1,765,334 (−85.9k, −4.6%).
  - Restarting at 1 gives up the refund for clearing the slot at the roll (≈ 12k gas in `submitGuess` and in the K-only
    request), so on today's mainnet schedule the change is about neutral (+0.1% / +0.2%) [I].
  - Within a day the two builds are identical (8 and 7 slots).

### Changes → code [V]

| Record | Before | F0.15 |
|---|---|---|
| Guess | `mapping(opId => Guess)`: a new entry, and new slots, on every guess | `Guess[3] trackGuesses`: one record per track, overwritten by each guess on it. A stale `bigH` stays when a non-outflow guess follows (`hasBig` tells which is valid), so no slot returns to zero. `getGuess(opId)` returns the record only while it is the latest on its track |
| Input replay guard (I5) | `usedInput[handle]`: one new slot per guess | `inputH` in the track's record: the same input twice in a row on a track is rejected; an older input replayed later is evaluated and is wrong, because it encrypts another op's challenge (K53 binds `c` to the op's content), and it counts against the submitter. `usedInput` stays only for PIN-reset digests (rare) |
| Op content hash | stored at opening (one slot) | recomputed from the op's fields (`PolicyMath.opHashOf`) when the challenge is checked; `challengeOf` and `OpOpened.challenge` are unchanged |
| Track | score, decay epoch, last guess, pending op spread over slots; `pendingOp` returned to zero after every finalize | one slot: `uint32 score · uint32 decayEpoch · uint64 lastAt · uint64 waitUntil · uint64 pendingOp`; after the first guess it never returns to zero |
| Back-off (§5.2 b) | derived from the score at read time | stored at guess time: `waitUntil = now + T2(budget score)`; on a correct result, after the refund, `lastAt + T2(new score)`; an owner change clears the old key's value |
| Asset counters | `reserved`, `pinCommitted` in their own slots, back to zero when nothing is pending; `spent`, `pinSpent` set to zero at every epoch roll | `reserved` (uint112) shares a slot with `configured`, `pinCommitted` (uint128) with `unit`; the epoch counters are stored as value + 1 once used, so the roll writes 1, not 0 (step 2, `f015b`) |
| `openMode` flag (B, F0.11 limit) | a separate slot (B's account creation cost ≈ 110k gas more on Sepolia) | in the flags slot |
| Amounts above 2^112 − 1 | — | never take the K-only path (in practice the unlimited approval, which was K+P anyway), always get the long delay, and are counted capped in `pinCommitted` / `pinSpent` |

**Side finding (in the Round 1 / F0.10 code, fixed) [Mock]:** after an unlimited approval on the PIN path, `pinCommitted`
held 2^256 − 1, and after it ran `pinSpent` did. The next PIN outflow of that token overflowed in `_bigClass`
(`pinSpent + pinCommitted + amount`), so every PIN outflow of the token reverted in `submitGuess` until the approval had
run and the epoch had rolled over. A regression test in `Policy.test.ts` fails on commit `78badaa`
with panic 0x11 in `PinLib._bigClass` and passes now. Funds were never at risk (the escape and the K-only path were not
affected); it was a liveness bug.

**Test hygiene:** the tests no longer rewrite the evidence files under `results/` on every run; `npm run test:record`
does (`WRITE_RESULTS=1`). This keeps the random χ² values and the calldata-dependent gas in the committed files stable.

### Attack simulation with the stored back-off [I] — `results/pin-attack-sim.json`

The model (`scripts/pin-attack-sim.ts`) gains the stored-wait variant ("+SW"), copied from the contract: the wait is fixed
when a guess is made (now + T2 of the shared budget score) and, after a correct result's refund, recomputed as last
attempt + T2 of the new score. Same method as F0.10: worst phase of the decay calendar on an hourly grid,
[min/median/max over phases], owner reaction 1 h.

| Semantics | Owner | 24 h | 7 days | 30 days |
|---|---|---:|---:|---:|
| F0.10 (derived wait), no D | does not react | 8 (5.2%) | 9 (5.9%) | 13 (7.1%) [12/12/13] |
| **F0.15 (stored wait)**, no D | does not react | 8 (5.2%) | 9 (5.9%) | **12 (6.9%)** [11/12/12] |
| F0.15, no D | lifts the restriction again and again | 7 (4.6%) | 8 (5.2%) | 12 (6.9%) |
| F0.15, no D | rotation (no K45) | 8 (5.2%) | 8 (5.2%) | 8 (5.2%) |
| F0.15, no D | escape | **4 (2.6%)** | 4 | 4 |
| F0.15 + K45, D present | rotation | **4 (2.6%)** | 4 | 4 |
| F0.15 + K45, D present | escape | 4 (2.6%) | 4 | 4 |

By reaction time, with an escape or a rotation with D: 15 min → 4, 1 h → 4, 8 h → 7 guesses (F0.10: 4 / 5 / 7). The
expectation in the second interim decision (§8.2, item 5.2: ≤ 12 without a reaction, ≤ 5 with an escape) holds. The
gain comes from the decay calendar: with a derived wait, a score that decays shortens a wait that is already running;
a stored wait keeps the value it had when the guess was made. The owner's cost (K43 table above) does not change.

### Limits

- **What still creates slots on a PIN transfer, and why it stays.**
  - Five ACL entries (four in `submitGuess`, one in `executeOp`). Zama's ACL keeps one entry per handle and address, and
    each guess makes new handles. Public decryption of `ok` and `big` needs `makePubliclyDecryptable`. The guardian's
    silent-alarm decryption of `isDuress` needs persistent permission for both the guardian and the account
    (`checkPersistAllowed` in `@fhevm/sdk` [V]), so `allowTransient` cannot replace it. The auto-added known-list entry
    is stored, so it needs `allowThis`. Intermediate results are already transient only (the executor allows them for
    the transaction), so `allowTransient` has nothing left to save on this path.
  - Three slots of the op record (four for an ERC-20: the token address). Its content must survive from the request to
    the execution, hours or days later.
- **Options not taken [I]:**
  - Decrypting `ok` and `big` as one encrypted 8-bit value would save one ACL entry per PIN transfer (≈ 111k gas on
    Sepolia's schedule) for two extra FHE operations. It changes `finalizeGuess` and the watchtower, and on today's
    mainnet schedule it gains about nothing.
  - Storing only the op's content hash and passing the content as calldata at the guess and the execution would save one
    slot (two for an ERC-20). But every caller and the watchtower would have to carry the content, and `getOp` could no
    longer show it.
  - Recycling op records in a ring would save the three op slots in steady state, but it needs eviction rules for ops
    that never get a guess.
- **One-time slots:** an account's first guess on each track and its first op still open their slots once (sample #1
  of each run).
- **N = 5 per run.** In steady state the slot counts were identical in every sample; gas varied by tens of gas.
- **B variant:** not measured live in F0.15. Its PIN path is A's code. Its synchronous K-only path writes only `spent`,
  which no longer returns to zero after its first use.

---

# Round 1 — Phase 0 packages (F0.1, F0.2, F0.4, F0.5*, F0.6) + Phase 1 core (F1.2*, F1.3 v0)

- **Date:** 8 November 2026
- **Toolchain:** `@fhevm/solidity` 0.13.4 · `@fhevm/hardhat-plugin` 0.13.0-1 (alpha; mock of the v0.13 host contracts) ·
  `@fhevm/sdk` 0.13.7 · Hardhat 2.29.1 (EDR, `prague`) · solc 0.8.28 (viaIR, cancun) · EntryPoint v0.8 · OpenZeppelin 5.6.1
- **Evidence classes:** **[M]** measured (live chain read or desktop), **[Mock]** ran in Zama's mock environment, **[V]**
  verified by reading code, **[I]** inference. There is NO Sepolia **[M]** testnet measurement in this round (a key is
  needed).

## 1. Summary

| | |
|---|---|
| Contract tests | **56/56** passed [Mock] (Round 1 run; `results/test-summary.json` holds the latest full-suite run) |
| SDK tests | **8/8** passed (Argon2id vectors, reference KAT, PIN policy) |
| Invariants | I1–I12, I14–I18 tested (I8/I14 partly: Phase 2); I13, I19 TEE (out of scope) |
| Size | All contracts < 24,576 bytes (`EncryptedAccount` 20,442) |
| E1 (go/no-go) | **Not measured.** `scripts/sepolia-e1.ts` is ready; it has to be run with the user's key |

## 2. Measured numbers

### 2.1 Live Zama protocol (8 November 2026) [M] — `results/live-chain-probe.json`

| | Sepolia | Ethereum mainnet |
|---|---|---|
| ACL | v0.5.0 | v0.4.0 |
| FHEVMExecutor | v0.6.0 (has `fheIsIn`, `fheSum`, `fheRandBounded`) | v0.5.0 (same selectors present) |
| HCULimit | v0.4.0 — 20,000,000 HCU/tx, 5,000,000 depth/tx | v0.3.0 — same |
| KMSVerifier | v0.4.0 — **7/13** signature threshold | v0.3.0 — **7/13** |

### 2.2 Gas and HCU per flow [Mock] — `results/cost-model-mock-round1.{json,csv}`

| Flow | Gas | HCU total | HCU depth |
|---|---:|---:|---:|
| K-only transfer request (isIn N=30 + threshold + sticky tripwire) | 1,226,772 | 774,036 | 634,032 |
| finalizeEvaluation (KMS proof + transfer) | 303,454 | 0 | 0 |
| PIN guess, outflow (okAny + isDuress + big) | 1,206,087 | 698,002 | 302,000 |
| PIN guess, admin op | 1,043,475 | 555,002 | 278,002 |
| finalizeGuess (2 handles) | 303,015 | 0 | 0 |
| Outflow execution + auto-known (isIn + select) | 729,222 | 667,032 | 667,032 |
| setupPin | 818,196 | 79,000 | 79,000 |
| setupAsset (τ draw included) | 1,411,179 | 1,195,064 | 1,172,000 |
| setupKnown (12 eaddress / proof) | 2,062,794 | 0 | 0 |
| tightenLimits (K-only, 4× encrypted min) | 907,276 | 876,000 | 438,000 |
| removeKnown (K-only, select) | 509,993 | 83,032 | 83,032 |
| startEscape / executeEscape (no FHE) | 34,534 / 50,158 | 0 | 0 |

### 2.3 E19 — known-list size [Mock]

| N | `FHE.isIn` HCU | `eq`+`or` (design doc 12.9) HCU | Ratio | `isIn` gas | `eq`+`or` gas |
|---:|---:|---:|---:|---:|---:|
| 8 | 286,032 | 1,264,032 | 4.4× | 320,025 | 945,492 |
| 10 | 286,032 | 1,586,032 | 5.5× | 325,858 | 1,152,280 |
| 16 | 584,032 | 2,552,032 | 4.4× | 394,684 | 1,772,645 |
| 30 | 584,032 | 4,806,032 | **8.2×** | 555,239 | 3,220,167 |
| 32 | 885,032 | 5,128,032 | 5.8× | 578,176 | 3,426,956 |
| 60 | 885,032 | — | — | 899,365 | — |

`isIn` accepts at most 60 elements for types of ≥ 64 bits (61 → revert) [Mock]. Choice: N_recipients = 30, N_spenders = 10
(at HCU bucket edges).

### 2.4 E7 — tripwire threshold distribution [Mock] — `results/cost-model-mock-round1.json`

256 draws, [L_min, L] = [100,000, 300,000]: all within the range; 8-bucket chi-square **χ² = 10.19** (df = 7; p = 0.001
threshold 24.32) → consistent with a uniform distribution. ≈ 977,000 HCU per draw (16 draws in one tx: 15.6M HCU).

### 2.5 E17 — Argon2id v1 (m = 64 MiB, t = 3, p = 1) [M desktop] — `results/argon2id-desktop.json`

AMD Ryzen 5 5600, Node 22, hash-wasm (WASM): **p50 180 ms, p95 186 ms** (20 runs). No phone or browser measurement in
this round.

## 3. Package acceptance criteria

| Package | Criterion | Status |
|---|---|---|
| F0.1 | The same handle is rejected the second time | ✔ [Mock] `InputReplayed` |
| F0.1 | An old guess with a new `c` gives `ok = false` | ✔ [Mock] |
| F0.1 | The counter increments at guess time | ✔ [Mock] (`consecutive = 1` before finalize) |
| F0.1 | Restricted mode at the 3rd consecutive wrong guess | ✔ [Mock] as soon as the 3rd attempt is submitted |
| F0.1 | Sepolia p50/p95, gas, HCU | ✘ no Sepolia; mock gas/HCU available |
| F0.1 | I3, I5, I10, I18 | ✔ |
| F0.2 | UserOp → pending op → PIN → execution | ✔ [Mock] with the real EntryPoint v0.8 |
| F0.2 | No FHE in validation | ✔ [V] `validateUserOp` is ECDSA only |
| F0.2 | ETH cannot be drained through the gas fields | ✔ [Mock] a UserOp without a paymaster is rejected |
| F0.3 | Viewing via snapshot | ✘ deferred together with Phase 2 (private mode) |
| F0.4 | Anomaly branches, combined bit, sticky tripwire, watchtower flag | ✔ [Mock] |
| F0.4 | Approvals count against the threshold, an unlimited approval needs the PIN | ✔ [Mock] |
| F0.4 | Overflow and concurrency | ✔ [Mock] (reservation; 2^64 → PIN path) |
| F0.4 | I1, I2, I11, I12, I16, I17 | ✔ |
| F0.5 | The bond goes to the account and doubles | ✔ [Mock] (E12) |
| F0.5 | Cost model | ✔ [Mock] (to be re-measured on Sepolia) |
| F0.5 | Duress trace | ◐ setup data-flow equality tested; full E5 in Phase 2 |
| F0.6 | A PIN on the common-PIN list cannot be set | ✔ (client) |
| F0.6 | K + old P; a wrong old PIN counts on the same counter; the old PIN stays valid during the delay; I15 | ✔ [Mock] |
| F0.7 | Port to a second FHE provider | ✘ not done |
| F1.2 | Scenarios 11.4 1–5, 8, 10, 11; veto; lockout; I6, I7, I9, I15, I18 | ✔ [Mock] |
| F1.3 | Auto-finalize, notification, freeze on tripwire | ✔ [Mock] watchtower v0 |

## 4. Open questions (arising from this round)

1. E1: public decryption latency on Sepolia and ZK input-proof generation time (client) — go/no-go decision.
2. Is the coprocessor threshold for computation integrity (3 of 5) part of the known issue (K17)? The design doc only
   mentions the KMS.
3. Reorgs (R9): Zama processes ACL events as soon as they are in a block; is that acceptable for PIN guesses?
4. Once user decryption with ERC-1271 (SDK v0.14.1) reaches the live network, can the viewing design (15.3) be simplified?
5. H1: the litepaper says that builders on the protocol need no additional license; written confirmation.

## 5. Notes for the next package

- `@zama-fhe/relayer-sdk` is unsupported as of 6 November 2026; the client and the watchtower must use `@fhevm/sdk`.
- The alpha Hardhat plugin has three issues, worked around in this repository: (1) reverts it cannot decode through an
  ERC-1167 clone surface as "Fhevm assertion failed" (authorization-revert tests use `.staticCall`); (2) its
  `eth_sendTransaction` hook crashes Node on `EntryPoint.handleOps` (those transactions are sent with a raw-signed ethers
  wallet); (3) nondeterministic native crashes when many test files share one process (`npm test` runs
  `scripts/run-tests.mjs`: one process per file, retrying only crashes).
- The mainnet relayer requires an API key; decryption fees in ZAMA add to the watchtower's operating cost (no FHE fee on
  the host chain).
