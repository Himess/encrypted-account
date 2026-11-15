# F0.16 — owner-track bond, adjustable bond, protocol fee, PIN guidance (design note)

Status: implemented on the local branch, not deployed. Code, tests and measurements: see RESULTS.md (F0.16).

## 1. Owner-track bond

Goal: every wrong K-track guess costs the guesser money, and the money stays with the account owner.

- **Formula.** `s` is the K-track score at submission (decayed, before this guess's provisional +1):
  `bond = ownerBaseBond << min(s, 20)`. The first guess costs the base too (decision after the first report: on a
  large account no guess should be cheap). With the default `ownerBaseBond = BASE_BOND` this is exactly the recovery
  track's `bondFor(s)`, so default accounts behave as before.
- **When the score is read.** At submission, from the stored score (PolicyMath.score). A track holds one guess in
  flight (`SlotBusy`), so no second K-track guess can be priced at an old score; the next guess sees the previous
  wrong guess's +1. The lane and the recovery track have their own scores and do not lower the K-track bond.
- **Who pays.** Only a direct call from K: `msg.sender == owner`, never the EntryPoint, never the account itself.
  `msg.value` (all of it) is the bond; less than required reverts with `BondTooLow(required)` and nothing is counted.
  The EntryPoint always calls the account with value 0, and the account has no generic `execute` and cannot call
  itself (openCall forbids it), so no path can pay a bond from the account's own balance. A K-track guess through
  the EntryPoint reverts with `DirectBondRequired`.
- **Effect on the AA flow.** UserOps keep everything else: opening ops, K-only transfers, finalizing, executing,
  the lane (unbonded), admin. A K-track PIN guess now has to be a plain transaction from K's EOA, which pays gas and
  a refundable bond (0.001 ETH when the score is 0). The web app already sends guesses this way; it adds `value`.
  A wallet that runs only through a paymaster has to send K-track guesses from K's EOA or use the lane.
- **Result.** Correct PIN: the bond is credited back and pulled with `claimRefund` (nonReentrant, state cleared before
  the transfer). A K-track bond is always K's (a direct call by the owner key), so it is owed to the owner key and kept
  in `ownerRefund`, packed next to the owner address; after a rotation that ran in between, the new key collects it.
  Recovery-track bonds keep the per-payer `refunds` map. Wrong PIN: the bond stays in the account.
- **Storage.** No new slot: the guess record keeps the bond in the slot every guess writes anyway (with `opId` and the
  flags), and writes the payer address only on the recovery track; `ownerRefund` shares the never-zero owner slot. An
  earlier layout opened one slot on the first bonded guess and one on the first refund (≈111k gas each on Sepolia).
- **Guesses that never settle.** `finalizeGuess` is permissionless and still works when an escape or an owner change
  cancelled the op meanwhile: a correct guess is refunded, a wrong one kept. A guess that is never finalized keeps
  its bond in the account (the suggested default). Refunding pending bonds when an escape starts was considered and
  rejected: the escape must contain no bond logic.
- **Unbonded paths.** The lane (K + D or helper co-signature) stays free, so the owner's recovery path costs nothing.
  The escape is untouched: no FHE, no bond, no fee call. The recovery track keeps its own bond.
- **Paymaster and relayer.** The repository's only paymaster is `TestPaymaster` (tests and Sepolia scripts). It
  sponsors UserOp gas, and a UserOp cannot carry a bond, so it cannot post bonds for anyone. No relayer in the
  repository submits guesses.
- **Known limitation (pre-existing for recovery bonds).** Unclaimed refunds are not reserved: an escape sweeps the
  whole ETH balance to E_addr. For the K-track the payer is K's EOA, so the money reaches the owner either way;
  third-party payers on the recovery track should claim promptly.
- **Deferred.** A third party paying the bond for K (a relayed, K-signed guess) is possible but costs account bytes;
  EncryptedAccountB has under 1 KiB left. Open question.

## 2. Adjustable base bond for large accounts

- **Setting.** `ownerBaseBond`, public, per account: default and minimum `BASE_BOND` (0.001 ETH), maximum 100 ETH, in
  multiples of BASE_BOND. Stored as a uint32 count of BASE_BOND units in a slot the account already has (no new
  storage slot; 0 means the default).
- **Why 100 ETH.** The bond doubles per wrong guess, so a modest base already prices out guessing on a large account
  (pin-attack-sim). A higher cap mainly protects against a typo (a value meant in another unit), which would make
  the K-track unusable until the lane or the escape is used.
- **Who sets it.** The owner at setup (`setupOwnerBond`), later only with a PIN-verified admin op
  (`A_SET_OWNER_BOND`, settings delay). K alone cannot change it.
- **The owner's side.** A raised base is sent with every PIN entry of the owner as well (send, "I'm here", heirs, PIN
  change) and comes back with `claimRefund` when the PIN is right. The app says so on every PIN screen and points to the
  lane, which needs no bond; the web app has no lane flow yet (not coded, as decided).
- **No lock-out.** At a high score the bond can exceed what the owner wants to post. The owner then uses the lane
  (unbonded, needs D or the helper) or the escape (no PIN); the score also decays by one point a week.
- **Privacy.** Only this setting is public (a guesser must know what to send). Limits, tripwire and known sets stay
  encrypted.

## 3. Protocol fee on PIN-verified transfers

- **Scope.** PIN-verified ETH and ERC-20 transfers executed by `executeOp`, and generic calls that carry ETH (the same
  fee as an ETH transfer of the call's value: otherwise `openCall(recipient, value, "")` would send ETH without it).
  Free: K-only transfers, approvals, calls without value, admin, recovery, cancellation, the escape, will claims,
  deposits, the instant bucket and variant B's synchronous K-only transfers.
- **No token route through generic calls.** `openCall` already rejected `transfer` and `approve`. It now also rejects
  `increaseAllowance`, `transferFrom` out of this account (DAI and WETH9 skip the allowance when the owner calls
  it), the ERC-1363 `transferAndCall` / `approveAndCall` / `transferFromAndCall` (out of this account), ERC-777 `send`,
  `operatorSend` (out of this account) and `authorizeOperator`, and DAI's `push` and `move` (out of this account).
  Pulls into the account stay allowed. Cost: +339 bytes in OpenLib, nothing in the account. What stays open: a token's
  other non-standard functions, and approvals, which carry no fee, so an approved spender can pull without one.
- **Formula.** `fee = clamp(amount * feeBps / 10_000, minFee, maxFee)`, per asset, in the asset's unit. A flat fee
  is `feeBps = 0, minFee = maxFee`. The fee is added on top: the payee always receives exactly `amount`.
- **FeeConfig.** One contract that every account clone reads (its address is an immutable of the implementation):
  admin, `feeRecipient`, per-asset `feeBps / minFee / maxFee`, a version that increases on every change. Hard cap
  `feeBps <= 100` (1%), and the cap also bounds the final fee: `quote` never returns more than 1% of the amount, so a
  high `minFee` cannot get around it (a minimum above 1% of a small amount is cut to 1%). Increases wait 7 days (users
  can leave first); decreases apply at once. The initial table is set in the constructor, before any account exists.
  Unknown assets pay no fee.
- **Bound at opening.** When a transfer op opens, the account asks FeeConfig for the fee and stores it in the op: a
  uint96 packed next to `counterparty`, which is never zero for a transfer, so no new slot. An ETH-carrying call keeps
  its fee in `callFee`, packed next to `target` (a call's counterparty is zero). (Packing it next to `target`
  was the first layout; `target` is zero for ETH, so every ETH transfer opened a new slot. The F0.16 cost measurement
  caught it.) A non-zero fee is part of the op's content hash, hence of the PIN challenge: the PIN approves amount and
  fee together, and later config changes do not touch the op.
- **Insufficient balance.** If the account cannot pay amount + fee, `executeOp` reverts and the op stays delayed;
  it can run once the balance is there.
- **FeeConfig failure.** Quoting is a try/catch: a reverting FeeConfig gives fee 0 at opening. At execution the fee
  goes to `feeRecipient()`; if that call or the fee transfer fails, the fee is skipped (`FeeSkipped`), so a broken
  fee module never blocks a verified transfer. The escape never calls FeeConfig; a K-only request calls `quote` when
  it opens (inside the try/catch, ≈9.4k gas) and never pays.
- **Variant B and confidential tokens.** B uses the same PIN path, so the fee applies there too. ERC-7984 transfers
  do not exist in the account yet; FeeConfig is keyed by asset address, so a confidential path can add its own quote.
- **Limits.** The fee does not count against the spending limits (they count `amount`).
- **Testnet default.** ETH: 10 bps, min 0.00001 ETH, max 0.001 ETH; `feeRecipient` is a deploy parameter.
- **Admin.** On testnets the deployer; on mainnet a multisig.
- **Bytes (F0.16 round 2).** The ETH fee on calls: +77 bytes in the account (it passes `feeConfig` to `openCall`),
  +425 in OpenLib, +453 in OpsLib; the token-route checks: +339 in OpenLib. EncryptedAccountB: 24,476 of 24,576 bytes.

## 4. PIN choice: the user decides, the app guides

SDK (`sdk/src/pinPolicy.ts`) and web only; no contract change. The existing short reject list (296 PINs) stays as it
is, and it is still the only thing that blocks.

- **Random PIN.** `randomPin()` behind a "Random PIN" button; the app shows it large and asks for it again. It skips
  PINs that would raise a warning, so a suggestion never looks like a date or a pattern: 779,404 of the 10^6 six-digit
  PINs remain (19.57 bits instead of 19.93), drawn uniformly.
- **Note.** `PIN_NOTE`, next to every PIN field: the harder the PIN is to guess, the safer the account; avoid birthdays,
  phone numbers, licence plates and patterns like 123456; a random PIN is the safest.
- **Warnings, never blocks.** Dates (6 and 8 digits), years, few distinct digits, repeats, mirrors, sequences of four
  (0 follows 9) and keypad patterns (walks over neighbouring keys, two keypad lines).
- **Duress PIN.** `checkDuressPin`: the same checks, it must differ from the PIN (after NFKC normalization, as the
  fingerprint), and one typo away from the PIN is a warning. The demo app offers no duress PIN: it has no guardian to
  receive the silent alarm, so a duress PIN would only act as a second correct PIN there.
- **Screens.** Setup and the new PIN-change sheet use the same chooser (note, warnings, random PIN). The app has no
  flow for entering the PIN on a second device yet, so the separate-device suggestion has nowhere to go; it belongs to
  the planned phone flow.
- **Base bond suggestion.** `suggestOwnerBaseBond(value)`: about 1% of the account value for a human-chosen PIN (each
  of the first guesses succeeds with ≈0.65%, Markert), value / 10^6 for a random PIN; at least 0.001, at most 100 ETH.
