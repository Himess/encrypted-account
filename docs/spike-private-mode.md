# Spike: private mode as a module (ERC-7984)

Branch `spike/private-mode`. Research code, not audited, Sepolia only. It answers the questions that had to be measured
before a full design of the private mode ("deniable account") from design doc v0.4, Phase 2 (F2.1–F2.3).

## What was built

| Piece | File | Size |
|---|---|---|
| Host account: variant A plus a fallback that DELEGATECALLs a fixed module | `contracts/private/EncryptedAccountP.sol` | 23,643 B (A: 23,264 B) |
| Private-mode module (runs in the account's context) | `contracts/private/PrivateModule.sol` | 7,908 B |
| Namespaced storage of the module (ERC-7201) | `contracts/private/PrivateStorage.sol` | — |
| Hook for PIN-verified private ops | `contracts/account/OpsLib.sol` (+275 B → 13,035 B) | — |

B is not touched (24,476 B, 100 B left). PinLib, PolicyLib and OpenLib are unchanged, so the Sepolia run reuses the
F0.16 deployments of those three libraries.

Three paths:

- **`privateTransfer`** — K alone, one transaction, no decryption. The design doc's synchronous formula
  (`room = τ − spent`, `fits = amount ≤ room`, `pass = known ∧ ¬tripped ∧ fits`,
  `moved = token.transfer(to, select(pass, amount, 0))`, `spent += moved`, `tripped |= ¬fits`). Two changes:
  `room` is computed as `max(τ, spent) − spent`, because `tightenLimits` can push τ below `spent` and the plain
  subtraction would wrap around; and the pass bit and the moved amount are allowed to the guardian only, never to K.
- **`openPrivateView` + PIN** — the balance becomes visible to K as a fresh snapshot
  `select(isDuress, min(balance, decoyLeft), balance)`, allowed to K. It runs inside `finalizeGuess` (no delay).
- **`openPrivateTransfer` + PIN** — a delayed transfer of an encrypted amount. Under duress the decoy behaves like a
  balance: up to `decoyLeft` moves, more moves zero (`select(amount ≤ decoyLeft, amount, 0)`), exactly like an
  ERC-7984 transfer above the balance. The doc's `min(amount, decoyLeft)` would produce partial transfers that a real
  balance never produces.

`OpsLib.afterGuess` stores the encrypted duress flag of the verification with the op (`op.h2`, design doc §17.6): the
per-track guess record that holds it is reused by the next guess. Duress is off by default (the duress slot takes FHE
randomness and the decoy cap is a random client-encrypted value, so the dataflow does not show whether a duress PIN
exists).

## Mock results (`npx hardhat test test/PrivateModeSpike.test.ts`, evidence `results/spike/private-mode-mock.json`)

| Test | Measured | Result |
|---|---|---|
| T1 one-tx private transfer | transactions, decryption requests, HCU | 1 tx, 0 decryption requests; 1,990,100 HCU (9.95 % of 20M), depth 1,058,032 (21.2 % of 5M) |
| T2 PIN-gated view | K alone: ACL, delegation, user decryption; after the PIN | K not allowed, no delegation, both user decryptions refused; after a correct PIN K reads the exact balance; a wrong PIN creates nothing; a later transfer leaves K blind again |
| T3 real vs duress PIN | 10 runs each, 70 transactions per mode, 11 metrics | 0 differences in execution gas outside the mock's cleartext layer, HCU, depth, EVM steps, calldata length, events, ACL grants, decryption requests, storage writes, transient writes, external calls |
| T4 silent zero | over-limit, sticky tripwire, above balance, who learns | no revert, an encrypted zero moves, the tripwire stays set; K cannot read the outcome, the guardian can; a passing and a failing transfer have identical traces |

**The mock leaks values through gas.** Its `CleartextFHEVMExecutor` runs the real symbolic operation and then sends the
plaintext result to a cleartext layer (`CleartextArithmetic` → `CleartextDB`) that stores it for the debugger. Storing
0 costs about 19,900 gas less than storing a non-zero value, so on the mock the gas of an FHE operation depends on its
secret result (for example `isDuress` and `¬okReal` are 0 with the real PIN and 1 with the duress PIN: 2 × 19,900 =
39,800 gas). The production executor has no such layer. The test therefore traces every transaction
(`debug_traceTransaction`) and separates the gas and steps spent inside the cleartext layer; all 40 raw differences sit
there. A CI indistinguishability test has to do the same, or run against a production executor.

Total gas (without the cleartext layer) differs between pairs by at most 36 gas; every such difference equals
−12 gas × the difference in zero bytes of the calldata (random ciphertext handles, proofs and challenges). The same
spread appears between two runs of the same mode.

## Sepolia (`scripts/spike/sepolia-private.ts`, evidence `results/spike/sepolia/`)

A fresh EncryptedAccountP account holding Zama's official **cUSDC (Mock)** wrapper, looked up in the Wrappers Registry
(`0x2f07…128e` → `0x7c5B…3639`, valid, rate 1). The F0.16 PinLib, PolicyLib and OpenLib deployments are reused; OpsLib,
PrivateModule, EncryptedAccountP and a factory are new. The F0.16 factory, its accounts and the site are not touched.

- **K alone, on the real KMS:** user decryption of the account's balance, through the token or through the account, is
  refused ("not authorized to decrypt handle"); so is K's attempt to read the pass bit of a K-only transfer.
- **T1 (N = 5):** one transaction, no decryption request; HCU 1,990,100 (exactly the mock's); gas 2,749,430 on the first
  run, 2,447,556 after. Total p50 14.3 s, p95 16.0 s = input proof p50 4.7 s + inclusion p50 9.4 s; no decryption.
  The guardian reads the pass bit p50 8.1 s after the transaction.
- **T2 (N = 5):** every snapshot decrypted to the exact balance. Total p50 40.3 s, p95 46.0 s = Argon2id 0.2 s (in
  parallel) + input proof p50 5.0 s + three inclusions p50 25.8 s + public decryption of the yes/no bit p50 4.8 s + user
  decryption of the snapshot p50 2.9 s (p95 8.1 s). Gas (warm): open 281,149, guess 844,905, finalize with the view
  957,052.
- **T3 on the production executor:** the test account has a duress PIN (the product default is still none); every
  real-PIN view of T2 is paired with a duress-PIN view. The account's first PIN-gated op (T2 #1) opens one-time slots
  (3/8/4 new slots against 2/3/3 later; the gas gap is exactly 1, 5 and 1 × 97,920), so it is the warm-up. The four warm
  pairs plus a cross-check (real #2 vs duress #1): **15 transaction pairs, 0 differences** in execution gas, HCU, depth,
  calldata length, events and ACL grants; total gas differs by at most 48 gas, every time by −12 gas per calldata zero
  byte. All five duress views showed the decoy (2,000), all real views the balance (9,950). The three pairs of PIN-gated
  transfers were skipped: the burner was 0.0008 ETH short (code deposit on Sepolia costs ≈1,560 gas per byte, so the
  four deployments alone took 72.8M gas).
- **Mainnet equivalent** (`scripts/spike/sepolia-slots.ts`, new slots from the block access lists, 110,983 vs 22,445 gas
  per new slot): T1 2,447,568 gas with 13 new slots → ≈1,296,600 on today's mainnet schedule; the PIN-gated view
  ≈1,374,800 in total. For reference, A's two-phase K-only ETH path ≈1,150,300 and B's one-transaction path 59,820.

## Deniability budget (T5)

`scripts/spike/deniability-model.mjs` → `results/spike/deniability-model.json`. A coercer anchors on what was shielded
minus what was unshielded (public amounts) and asks whether the hidden payments since then could have brought the
balance down to the decoy. With k hidden payments of mean μ, the chance he gives the decoy D is
P(Poisson((N − D)/μ) ≤ k − 1); about (N − D)/μ hidden payments are needed for even odds.
