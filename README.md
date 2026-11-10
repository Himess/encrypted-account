# Encrypted Account

> A stolen seed phrase is not enough to drain the account.

An ERC-4337 smart account whose PIN fingerprint, spending limits, a random tripwire threshold that nobody knows
(not even the owner) and known recipient/spender lists are **encrypted** with Zama FHEVM and enforced on-chain — also
against whoever holds the account key (K). The PIN is asked only for unusual operations.

> **Status: research prototype.** Not audited. Testnet only — do not use it with real funds. The tests run against
> Zama's mock (cleartext) stack; the contracts were deployed to Sepolia and measured end to end (latency, gas, HCU).
> Every number below points to raw data in `results/`; methodology and transaction hashes are in
> [RESULTS.md](RESULTS.md).

## What it does

| Situation | What happens |
|---|---|
| Known address, below the hidden threshold | Key (K) only; two-phase encrypted check, the watchtower finalizes automatically |
| Address never paid before / above the hidden limit | PIN + delay |
| Very large outflow (above L_big) | PIN + long, cancellable delay |
| K-only attempt above the hidden tripwire τ | Nothing moves; sticky tripwire, silent alarm to the watchtower, restricted mode |
| Unlimited approvals, unknown calls | Always PIN + delay (default deny) |
| Wrong PIN | Every guess adds 1 to a wrong-guess score before its result is revealed; a correct PIN never lowers it; the 3rd wrong guess restricts the account; back-off 15 min · 4^(n−3), capped at 7 days; the score decays by 1 every 7 days |
| Key stolen (panic button) | Escape: K alone, immediately. Every pending op is cancelled and PIN guessing closes; after 30 days the funds can go only to the pre-set escape address. Only the second device or recovery helper + PIN can cancel it |
| Key rotation in progress | With a second device or recovery helper, PIN guesses with the old key are closed until the rotation executes or is cancelled |
| Phone lost | PIN from a new device + bond → 7 days → new key; K alone cannot cancel it |
| PIN forgotten | K + second device or recovery helper → 30 days; with neither, escape |
| Zama down / account censored | Escape: K alone + 30 days, funds only to the escape address (no FHE needed) |
| Escape address | Set and changed only with its own signature (EIP-712; ERC-1271 for contract wallets); optional signed ping |
| Variant B (chosen at setup): listed address, within the public limit | K only, one transaction, no FHE; the watchtower reports every transfer. Unlisted or over the limit → the unchanged PIN path |

## Design in brief

- **A PIN as an on-chain second factor, without a server.** The client derives a 64-bit fingerprint with Argon2id
  (64 MiB, t = 3, per-account salt) and encrypts `fingerprint + challenge` (the challenge is bound to the op). The
  account compares it under FHE and only the boolean result is publicly decrypted. Every guess increments the
  wrong-guess score *before* its result exists, so the fingerprint can never be brute-forced offline and online
  guessing is rate-limited.
- **A hidden policy.** Per asset, L_min ≤ L and L_big are encrypted, and the tripwire τ is drawn with FHE randomness in
  [L_min, L). A K-only outflow is evaluated under FHE (`known AND NOT tripped AND spent + amount ≤ τ`); only the result
  bit is revealed, never which condition failed. Crossing τ sets a sticky flag that only the watchtower can decrypt.
- **An escape that needs no FHE.** K alone starts it; it cancels every pending op at once (O(1)), closes the anonymous
  PIN tracks and every K-only path, and after the escape delay sweeps the funds to the escape address. It keeps working
  if the FHE network is down or the account is deny-listed in the ACL.
- **Two variants of the open mode.** A (`EncryptedAccount`): encrypted policy, two-phase K-only path. B
  (`EncryptedAccountB`): public known lists and limit, one-transaction K-only path; the PIN path is unchanged. The mode
  is fixed by the implementation an account is cloned from.

## Measured

| What | Result | Data |
|---|---|---|
| PIN flow end to end, desktop client, N = 30 | p95 47.7 s | `results/sepolia/e1.json` |
| Local input proof on a phone (Galaxy A73, no COOP/COEP, single thread) | p95 13.65 s | `results/mobile-proof.json` |
| K-only transfer, interleaved A/B, N = 30 each | A: p50 20.1 s / p95 26.3 s, 1,949,477 gas · B: p50 7.2 s / p95 14.6 s, 59,820 gas, 0 HCU | `results/sepolia/f011-ab.json` |
| Account setup gas | A: 17,048,629 · B: 3,259,034 | `results/sepolia/setup-f011.json` |
| New storage slots per PIN-verified transfer (block access list), before → after F0.15 | 16 → 8; gas −22.6% on Sepolia, ≈ −3.5% on today's mainnet schedule | `results/sepolia/f015-slots.json` |
| Attack simulation: key stolen, human-chosen 6-digit PIN, 30 days | ≈ 7% with no reaction · ≈ 3% if the owner escapes within an hour · negligible for a random PIN | `results/pin-attack-sim.json` |

Sepolia runs a newer gas schedule than mainnet (a new storage slot costs ≈ 111k gas), so the gas figures are pessimistic
for today's mainnet. Package codes such as F0.9, F0.10 and F0.11 name the measurement rounds described in
[RESULTS.md](RESULTS.md).

## Known issues and trust assumptions

- **Zama threshold assumption.** 5 of the 13 KMS nodes colluding can break confidentiality; the fingerprint then leaks
  and the PIN check can be bypassed. The PIN itself is not revealed (Argon2id, per-account salt), and spending still
  needs the key.
- **Computation integrity** relies on a majority of the coprocessors (3 of 5 today). A compromised majority could forge
  a comparison result; the impact is in the same class as a KMS breach.
- **Open mode.** Amounts and recipients are visible on-chain, and `ok` bits accumulate information about the threshold
  over time. What stays hidden is the account's rules and lists.
- **Auto-known.** When enabled, recipients of PIN-verified sends join the known list, and this is traceable on-chain.
- **Variant B** makes the known lists (including entries added by hand and never used), the list size, the K-only
  limit and the epoch spending public, and it has no random tripwire.
- **Empty input proofs.** `FHE.fromExternal(handle, "")` accepts any handle the caller is already allowed to use; this is
  a documented library feature for smart-account integration. In a self-call or multicall path the caller is the
  contract itself, which is allowed on its own handles, so this account requires a non-empty proof for every user
  ciphertext (`PolicyMath.requireProof`). `contracts/test/NaivePinVerifier.sol` and `test/Exploits.test.ts` show why.
- **Governance.** Zama governance can deny-list an account in the ACL or pause the ACL; the escape path is not affected
  (tested).

## Roadmap

No dates; the order may change.

- **"Steal this wallet" (next):** a Sepolia account whose seed phrase is public. Without the PIN, the funds should still
  not move.
- **Web app:** a first version is in `web/` (create an account, send with the PIN); next: key-only transfers to known
  addresses, the escape, and the phone flow.
- **Private mode:** encrypted balances and amounts with ERC-7984 tokens, viewing with the PIN, a duress PIN.
- **Hidden inheritance:** if no PIN is entered for a long period, the funds go to heirs whose addresses and shares stay
  encrypted until then.
- **Agents and teams:** agent accounts (the agent holds the key, a human holds the PIN) and team treasuries with a
  hidden policy.
- **Standards:** ERC drafts for the encrypted secret factor and the encrypted policy hooks.
- **Before any mainnet use:** an independent review and an audit.
- **Research:** a TEE back-end with a threshold across hardware vendors, for more chains including Bitcoin.

## Build and test

```bash
npm install
npm run compile
npm test            # contract tests, one process per file
npm run test:sdk    # SDK tests, including Argon2id test vectors
npm run size        # 24 KiB contract size check
```

The FHEVM Hardhat plugin used here is an alpha release (0.13.0-1); `npm test` runs every test file in its own process
and retries native crashes.

## Web demo (Sepolia)

`web/` is a small browser app on top of the deployed Sepolia contracts: connect a wallet, choose a PIN and a hidden
limit, create the account (8 transactions), deposit, and send ETH with the PIN — or try a wrong one and watch it being
counted. The PIN never leaves the page: the browser derives the Argon2id fingerprint and encrypts it with Zama's SDK.
Accounts use short demo delays instead of the production examples.

```bash
npm run web:test     # the browser PIN fingerprint matches the SDK's test vectors
npm run web:serve    # builds web/dist and serves it on http://localhost:8790 (use a Sepolia wallet such as MetaMask)
npm run web:build    # static build for hosting → web/dist (COOP/COEP headers in vercel.json and _headers)
```

`node web/serve.mjs 8790 --devwallet` injects a test wallet for end-to-end runs without a browser extension; its key
(`SEPOLIA_UITEST_KEY`, created by `scripts/sepolia/uitest-wallet.ts`) stays in `.env.sepolia` and in the Node process.

## Sepolia measurements

The measurements use a burner wallet created only for this work. Its key lives in `.env.sepolia` (gitignored) and never
appears on the command line, in logs or in outputs. `SEP_RUN` only selects a run (state and output files get a suffix);
it holds no key.

```bash
npx hardhat run scripts/burner.ts                    # creates the burner, prints only its address
npx hardhat run scripts/sepolia/estimate-funding.ts  # gas price, preflight checks, suggested funding
npx hardhat run scripts/check-secrets.ts             # verifies that the key appears in no other file
npx hardhat run scripts/sepolia/f09-prepare.ts       # baseline: deploy, set up measurement accounts
npx hardhat run scripts/sepolia/f09-run.ts           # PIN flow + K-only hot path (N = 30, resumable)
npx hardhat run scripts/sepolia/f09-live.ts          # live checks (isIn, empty proof, ERC-4337, escape)
npx hardhat run scripts/sepolia/f09-report.ts        # live vs mock cost model, state growth
npx hardhat run scripts/sepolia/snapshot-f010.ts     # build snapshot for the F0.10 run
SEP_RUN=f010 npx hardhat run scripts/sepolia/f010-prepare.ts
SEP_RUN=f010 F09_N=5 npx hardhat run scripts/sepolia/f09-run.ts
SEP_RUN=f010 npx hardhat run scripts/sepolia/f010-live.ts
npx hardhat run scripts/sepolia/snapshot-f011.ts     # A + B build snapshot
SEP_RUN=f011 npx hardhat run scripts/sepolia/f011-prepare.ts   # deploy, A and B accounts, warm-up
SEP_RUN=f011 npx hardhat run scripts/sepolia/f011-run.ts       # interleaved A/B K-only hot path, N = 30
node scripts/f011-results.mjs                        # A/B table → results/f011-summary.json
npx hardhat run scripts/sepolia/snapshot-f015.ts     # F0.15 build snapshot (SEP_RUN=f015b: step 2)
SEP_RUN=f015 npx hardhat run scripts/sepolia/f015-prepare.ts   # deploy, e1 and hot accounts
SEP_RUN=f015 F09_N=5 npx hardhat run scripts/sepolia/f09-run.ts
npx hardhat run scripts/sepolia/f015-slots.ts        # new slots per transaction (block access list), F0.10 vs F0.15
```

Other tools:

```bash
npx ts-node scripts/pin-attack-sim.ts   # attack simulation (exact model of the contract semantics)
node scripts/f010-cost-diff.mjs         # mock cost difference, Round 1 → F0.10
node bench/build.mjs                    # single-file Argon2id phone bench → bench/argon2id.html
node bench/proof/build.mjs              # input-proof phone bench → bench/proof/dist/
```

## Layout

```
contracts/account/
  EncryptedAccount.sol        ERC-4337 account (implementation behind the clones), entry points — variant A
  EncryptedAccountB.sol       variant B: public lists and limit, one-transaction K-only path (inherits A)
  AccountStorage.sol          ERC-7201 namespaced storage, errors, events
  PinLib.sol                  secret factor: fingerprint, challenge, two-phase verification, wrong-guess score
  PolicyLib.sol               hidden limits, random tripwire, encrypted known lists, evaluation
  PolicyMath.sol              score, decay and back-off; op liveness (escape cancellation); counter generations
  OpsLib.sol                  pending-op state machine, delays, execution, escape sweep
  OpenLib.sol                 opening ops, admin parameter checks, co-signatures, escape address (EIP-712)
  EncryptedAccountFactory.sol counterfactual ERC-1167 clone factory
contracts/test/               test and benchmark contracts, including a deliberately vulnerable PIN verifier
sdk/src/                      Argon2id fingerprint, PIN policy, watchtower v0
web/                          browser demo on Sepolia (create an account, send with the PIN)
test/                         mock-stack tests (PIN, policy, recovery, ERC-4337, exploits, cost, F0.10, F0.11)
scripts/                      Sepolia measurement scripts, simulations and reports
bench/                        phone benches (Argon2id, input proof)
results/                      raw measurements and evidence (JSON, CSV)
```

## License

MIT — see [LICENSE](LICENSE). Zama's libraries are under their own license (BSD-3-Clause-Clear).
