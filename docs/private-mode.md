# Private mode (optional)

Branch `feature/private-mode`, cut from `spike/private-mode`. Research code, not audited, Sepolia testnet only. This
note records what the optional private mode does, the decisions behind it, and what is still open. The measurements
behind the spike are in [spike-private-mode.md](spike-private-mode.md).

A private-mode account holds an ERC-7984 token (Zama's cUSDC on Sepolia) whose balance and amounts are encrypted. Its
owner sees the balance with the PIN, sends small amounts in one transaction with the key alone, sends anything else
with the PIN after a long wait, and may add a duress PIN that limits the loss under coercion. A standard account is not
affected by any of this.

## 1. Optional by construction

| | Standard account | Private-mode account |
|---|---|---|
| Implementation | `EncryptedAccount` (A) or `EncryptedAccountB`, unchanged | `EncryptedAccountP` = A + three overrides + a fallback to `PrivateModule` |
| Factory | the existing `EncryptedAccountFactory` deployments | its own `EncryptedAccountFactory(implP)` |
| Setup | 8 transactions (9 with a raised bond) | one more: `privateSetupAsset` (the private token's encrypted limits and hidden amount) |
| Big transfers | `delays.bigTransfer` as chosen | at least 72 hours (enforced at `privateSetupAsset`) |

The default contracts are byte-for-byte the code on `main`: the runtime bytecode of `EncryptedAccount`,
`EncryptedAccountB`, `PinLib`, `PolicyLib`, `OpsLib`, `OpenLib`, `EncryptedAccountFactory`, `FeeConfig` and the three
will contracts is identical once the trailing metadata hash is removed
([results/private-mode/standard-account-unchanged.json](../results/private-mode/standard-account-unchanged.json)). The
only edits to their sources are `virtual` on three functions of `EncryptedAccount` (`openCall`, `finalizeGuess`,
`executeOp`) and four constants in `AccountStorage`; neither changes the code. A standard account therefore has the same
flow and the same gas: `test/CostModel.test.ts` gives the same table on both branches within the mock's run-to-run noise
(at most 36 gas on a row; two runs of the same code differ on 7 of 35 rows), and HCU is identical on every row.

The setup screen offers **Private mode (optional)**, off by default. Inside it, **Duress PIN (optional)** is a second
switch, also off. With private mode off, the setup and the account are exactly the standard ones.

## 2. Turning it on later

| Option | Security | Cost | Existing accounts |
|---|---|---|---|
| **A. A module that any account can attach later** (an admin op, K + PIN + delay, sets a module address) | Every account carries a DELEGATECALL to a settable address: whoever sets it controls the account's whole storage. A K + PIN thief, or a bug in the setter, becomes a full takeover. The path exists in every account, including those that never use it. | Changes the default code: two hook branches and a storage read in `finalizeGuess` / `executeOp` for everyone (more gas on every PIN op). B has 100 bytes left, so B cannot take it at all. | Impossible either way (see below). |
| **B. The same, but only in accounts created from a new "module-ready" implementation** | As A for those accounts, and the decision has to be taken at creation anyway. | As A, for every new account. | Impossible. |
| **C. A new private-mode account, and a migration** (chosen) | The private code lives only in accounts that chose it; its module address is an immutable of the implementation, so no clone can point it elsewhere. Standard accounts keep the code that was reviewed for them. | One new account (≈ 9 setup transactions) and one PIN send per asset to move the funds (a PIN-verified ETH send pays the F0.16 fee: 0.1 %, at most 0.001 ETH). | Supported: this is the migration. |

**Existing accounts cannot be upgraded.** Each account is an ERC-1167 clone of a fixed implementation, with no proxy
admin and no upgrade path; that is on purpose, since an upgrade path is itself a way to take an account over. Turning on
private mode for an existing account therefore means moving to a new one:

1. Create a private-mode account from the same wallet (new escape consent; the new setup asks again for the PIN, the
   limits and, if wanted, a duress PIN).
2. Open the old account and send its ETH to the new address with the PIN. The new address is unknown to the old account,
   so this always takes the PIN path; above 10× the limit it waits the long delay. ERC-20 tokens move the same way.
3. If the old account has a hidden will, settle or replace it: a will belongs to the account that created it.
4. The old account can stay as it is; nothing else depends on it.

The web app follows this: a standard account shows a "Private mode (optional)" card that explains it and opens the setup
with private mode switched on, and an account switcher lists the wallet's accounts so the old one can send to the new one.

## 3. Escape with ERC-7984 tokens, and what it depends on

The escape keeps its rules. K alone starts it. While it runs nothing moves with the key alone (I21) and no new op
opens; cancelling it needs the lane (K plus a second device or the recovery helper, I22), so a thief with K and the PIN
cannot cancel it. Every op opened before it is cancelled (K54), including a scheduled PIN private transfer (tested).
After the escape delay anyone may send everything to the escape address, with no PIN.

`executeEscapeConfidential(tokens)` moves, for each of the account's private tokens, the whole encrypted balance handle
the account already holds to the escape address: `token.confidentialTransfer(escapeTo, balance)`. It needs no
decryption, no input proof, no relayer and no KMS at the time of the transaction, and it is permissionless.

**Dependence on Zama.** The token's transfer runs FHE operations and ACL checks, so the transaction needs Zama's FHE host
contracts on the chain (the executor and the ACL) to work. If they were paused or broken, the call reverts and the tokens
wait in the account, still under the escape's rules (no key-only path, no PIN op, no generic call to them); the sweep
can be retried by anyone later. Using the moved balance afterwards (reading it, sending it on, unwrapping it) needs
Zama's off-chain network (coprocessors, KMS, relayer), as for any ERC-7984 holder.

The ETH / ERC-20 escape (`executeEscape`) does not depend on Zama at all: its trace touches neither the executor nor the
ACL, and it runs with the executor's code replaced by one that always reverts (`test/PrivateMode.test.ts`, escape).

Other ways were weighed and set aside:

- Unwrap to the escape address: needs a public decryption by the KMS (asynchronous, a second transaction, more of Zama in
  the path).
- A standing operator right for the escape address: a leaked escape key could then take the tokens at once, with no
  escape and no delay.

## 4. Feedback to the owner

The key-only private send moves an encrypted zero when it breaks a hidden rule (the limit, the tripwire, an unknown
recipient). The key learns nothing; that is what makes probing the limit useless for a thief.

- **Watchtower.** The account's guardian (the watchtower) is allowed the key-only counter after each send, nothing else.
  From its change the watchtower tells: delivered (the counter rose by the amount), silent zero (it did not move), or the
  tripwire fired (it saturated to 2⁶⁴ − 1). The SDK watchtower emits `private-delivered`, `private-silent-zero` and
  `private-tripwire`, and on a new tripwire can restrict the account (`restrictOnTrip`). The service in
  [`watchtower/`](../watchtower/README.md) sends these to the owner's channel (Telegram or e-mail), with no amount in
  the text. Tested, and run on Sepolia.
- **Routing.** The app sends with the key alone only what is sure to pass: a known recipient and an amount within L_min
  minus what this device already sent with the key today (L_min ≤ τ always, so the owner's own sends never trip the
  wire). Everything else, a restricted account, or a device without the local record, takes the PIN path
  (`routePrivateSend`, SDK and web).
- **Without a watchtower** the web compares each PIN view with the previous one and the key-only sends in between, and
  says when the balance went down by less than was sent.

## 5. Cost of a key-only private transfer

| (mock, steady state) | Before (spike) | After | Change |
|---|---|---|---|
| Protocol gas (without the mock's cleartext layer) | 1,318,033 | 1,154,630 | −163,403 (−12.4 %) |
| HCU | 1,990,100 | 1,996,128 | +6,028 (+0.3 %) |
| HCU depth | 1,058,032 | 1,088,032 | +30,000 |
| Persistent ACL grants (new slots) | 13 (account 6, token 7) | 9 (account 2, token 7) | −4 |

How: the tripwire is folded into the key-only counter (it saturates to 2⁶⁴ − 1) instead of a separate encrypted flag,
and the guardian is allowed only the new counter instead of the pass bit, the moved amount and the flag. The 7 token
grants are inside the ERC-7984 token's own transfer and are not the account's to remove.

On Sepolia a new slot costs about 110,983 gas on the current schedule (22,445 on mainnet's). The spike's transfer
measured 2,447,568 gas there (13 new slots); the projection for 9 was about 1.93M. Measured on Sepolia with these
contracts (2026-11-16, steady state): **1,909,842 gas** (−22.0 %); with mainnet's slot price that is about 1.11M
(9 × 88,538 gas less; the spike's 2,447,568 is about 1.30M the same way).
Evidence: [results/private-mode/sepolia/summary.json](../results/private-mode/sepolia/summary.json).
Evidence: [results/private-mode/cost-before-after.json](../results/private-mode/cost-before-after.json).

**The hidden amount (§9) costs the key-only path three FHE operations** (`amount + hidden`, `≤ balance`, one more `and`)
and a balance read, and saves the PIN paths the decoy bookkeeping (mock, the same account history on both builds):

| (mock) | Decoy cap (first build) | Hidden amount | Change |
|---|---|---|---|
| Key-only transfer: protocol gas | 1,154,630 | 1,214,441 | +59,811 (+5.2 %) |
| Key-only transfer: HCU | 1,996,128 | 2,332,128 | +336,000 (+16.8 %) |
| PIN view (its finalize): protocol gas / HCU | 526,858 / 654,000 | 555,430 / 491,000 | +28,572 / −163,000 |
| PIN transfer (its execution): protocol gas / HCU | 642,717 / 1,442,128 | 562,839 / 1,226,096 | −79,878 / −216,032 |

HCU depth is unchanged on the key-only path (1,088,032). The view writes the (clamped) hidden amount each time, one more
ACL grant; the transfer no longer keeps a decoy counter. Not measured on Sepolia: no new persistent slot on the key-only
path, so the 1,909,842 gas above should grow by roughly the three operations' executor cost (about 60–90k, a projection).
Evidence: [results/private-mode/hidden-amount-cost.json](../results/private-mode/hidden-amount-cost.json)
(`scripts/measure/private-cost.ts`).

## 6. Indistinguishability test on every run

`test/PrivateIndistinguishability.test.ts` is part of `npm test`. It traces every transaction
(`debug_traceTransaction`), removes the frames under the mock's cleartext layer (`CleartextArithmetic` → `CleartextDB`,
found through `executor.getCleartextArithmeticAddress()`), and compares execution gas, HCU, HCU depth, EVM steps,
calldata length, events, ACL grants, decryption requests, storage writes, transient writes and external calls:

| Pairs | Transactions | Differences outside the cleartext layer | Raw differences (all inside it) |
|---|---|---|---|
| real PIN vs duress PIN: views, transfers within and above what the duress view shows, reset, duress setting, PIN change | 25 | 0 | 13 |
| a duress PIN set vs not set: setup and a real-PIN view | 5 | 0 | 3 |
| standard account (open mode): real vs duress PIN on an ETH transfer, an admin op and a PIN change | 12 | 0 | 3 |
| a key-only transfer that passes vs one that fails | 2 | 0 | 2 |

Total gas differs by at most 36 gas between pairs, and every such difference is explained by the zero bytes of random
handles and proofs in the calldata. The mock leaks values through gas (its cleartext layer stores plaintext results);
the production executor has no such layer.

On Sepolia (production executor, 2026-11-16, the first build of these contracts, with a decoy cap instead of the hidden
amount, §9): 6 PIN-gated transfer pairs (their execution is due
72 hours later) and 5 view pairs, 33 transaction pairs compared. HCU, HCU depth, events, ACL grants and calldata length
are identical in every pair. The 5 execution-gas differences are either the first use of a storage slot (the account's
first op, first guess and first view; the real-PIN half ran first) or within the ±4 gas spread seen among transactions
with the same PIN. Evidence: [results/private-mode/sepolia/summary.json](../results/private-mode/sepolia/summary.json).

## 7. Long delay

Every PIN-verified private send waits `max(bigTransfer, 72 h)`, and `privateSetupAsset` requires `bigTransfer ≥ 72 h`,
so big ETH sends of a private-mode account wait at least 72 hours too. Someone who forces the PIN still has to wait,
and an escape cancels the transfer meanwhile.

It applies to every private-mode account, not only to those with a duress PIN: the delay is public, and a longer one for
duress accounts would publish the duress setting. It applies to every PIN-verified private send, not only to big ones:
the amount is encrypted, and sorting sends by size in public would decrypt a bit about each amount.

## 8. Deniability warning

Shielding (wrapping) amounts are public and the private transfers are public events with hidden amounts. A coercer
anchors on N = shielded − unshielded and asks whether the k private payments since the last shield could have brought the
balance down to what the duress view shows, D = balance − hidden. With payments of mean μ, the probability is
P(Poisson((N − D)/μ) ≤ k − 1); the app takes μ as 4 % of N and D as N − hidden (nothing spent), so the figure it shows is
an upper bound. The web shows this next to the duress setting (weak below 0.2, fair below 0.5, good above), from the
account's own public history, and the test-token screen says that wrapping is public. It ignores everything off-chain:
a guide, not a guarantee.

## 9. Duress PIN semantics

Under the duress PIN every PIN path runs the same operations, writes the same slots and emits the same events; only
encrypted values differ. The duress PIN works on the balance minus the **hidden amount** H (the part the owner keeps out
of view, 0 without a duress PIN) as if that were the whole balance:

- view: `select(isDuress, balance − min(H, balance), balance)`; a duress view also clamps H to the balance, and it stays
  so (what the coercer saw is the anchor: a deposit he makes afterwards shows in full);
- private send: under duress up to `balance − min(H, balance)` moves, more moves zero (all or nothing, as a real
  balance above its value);
- key-only private send (no PIN, the same for anyone holding K): it moves only if `amount + H ≤ balance`, so K alone
  never reaches H either; an amount that would reach into H moves zero without tripping the wire;
- PIN change: lands on the duress fingerprint, the real PIN stays;
- tripwire reset: the same under both PINs;
- setting or removing the duress PIN: changes nothing under the duress PIN;
- generic calls can never reach a private token (`openCall` refuses it), so no unwrap or operator around H.

**Consistency: what a coercer can check.** Someone holding K and the duress PIN can compare the duress view with what
he did himself. The first build capped the duress view at a fixed decoy amount instead of keeping H out of view; it
failed three of these checks, which is why the semantics changed (`PRIVATE_MODE_VERSION` 1 → 2, a public constant of the
module, so the app knows which one an account runs):

| He does, then views under the duress PIN | First build (decoy cap) | Now | Test (`test/PrivateMode.test.ts`) |
|---|---|---|---|
| nothing (a second view) | same value | same value | a second duress view shows the same |
| sends a deposit to the account | unchanged while the balance was above the decoy: gives duress away | the deposit shows in full, also when H was above the balance (the first duress view clamps H) | a deposit shows in full |
| a duress send within / above the view | drops by the amount / unchanged | drops by the amount / unchanged | duress view and transfer |
| a key-only send to a known recipient | did not drop; a send above the decoy but within the key-only limit moved real funds | drops by what moved; above the view it moves zero and does not trip | K alone never reaches the hidden amount |
| trips the wire, resets it under duress, sends with K | the reset did nothing: the next send moved zero | the reset works as under the real PIN | a reset under the duress PIN |
| changes "the PIN" under duress, then uses the new and the old one | new works, old fails | new works, old fails | PIN change under the duress PIN |
| sets a "new duress PIN" under duress and tries it | it fails | it fails (limit 1 below) | limit (documented) |

Limits that remain:

1. A duress PIN set under the duress PIN changes nothing, so a coercer who knows the protocol can set one and try it.
   Two fingerprint slots cannot give him a working third PIN without exposing the real one. The settings delay (24 h by
   default) is the time the trusted contact has.
2. Outside the private token the duress PIN is a full PIN, as in the standard account: ETH and ERC-20 balances are public
   anyway, and PIN-verified ops on them (sends, a new known recipient, a key rotation, a guardian or escape change, a
   generic call) run after their delays as under the real PIN. The silent alarm tells the trusted contact in time.
3. The owner's own key-only sends come from the part above H too: a large H also limits what K alone can send.
4. If the owner spends below H with the real PIN, the duress view shows 0, as an empty balance.
5. Public history (§8) is the other check a coercer has; the app shows how believable the view is against it.

The watchtower can read the duress flag of a PIN check (as in the standard account); it is the owner's chosen helper.

**Silent alarm.** The watchtower service ([`watchtower/`](../watchtower/README.md)) decrypts the duress flag of every
guess off-chain, through Zama's relayer and KMS, real PIN or not, so its requests look the same either way. When the flag
is set it sends a silent alarm to the trusted contacts the owner chose in advance (family, a lawyer, a security
company), and to nobody else:

- never to the owner's own device or channel (the config check rejects a trusted contact that is also an owner channel,
  the same mailbox written another way included, and the router drops it again at runtime);
- nothing on-chain: the service sends no transaction around a PIN entry (it never finalizes; no restriction, no
  freeze), and the contracts emit the same events as for the real PIN;
- the alarm says which account, when, that the duress PIN was used, and the owner's optional short note; never a
  balance or the hidden amount (no message of the service carries an amount);
- the owner's own notices are the same for a real and a duress PIN;
- the trusted contacts and channels live in the service's config file, never on-chain.

It does not call anyone by itself: it sends a message, and what happens next is up to the person who gets it.

On Sepolia (fake channel, 2026-11-16) the alarm was written 11 times out of 11 duress guesses, p50 5.7 s / p95 8.2 s
after the client saw the guess transaction; no alarm for a real PIN, nothing about it to the owner, and the watchtower's
nonce did not change during the run. Wrong PINs reached the owner 4.3–6.8 s after the guess (one of them 103 s before it
was finalized), a silent zero 7.4 s after the transfer.

## 10. What the app keeps on the device

For a private-mode account the web app stores: L_min and the known recipient (to route sends), today's key-only send
amounts (each within L_min, older days dropped), and scheduled PIN sends without their amounts. It never stores whether a
duress PIN is set, the hidden amount, or any balance; a viewed balance stays on screen for a minute and only in memory. Someone
who forces the owner to open the app should not find the real figures there.

## 11. Tests

- `test/PrivateMode.test.ts` (20): setup rules; key-only delivery, silent zero, sticky tripwire and reset, unknown
  recipient, tighten; PIN view, 72-hour transfer, duress view and transfer, PIN change and duress setting under duress;
  the consistency checks of §9 (a second view, a deposit, a key-only send against the hidden amount, a reset under
  duress, the documented limit); guards; the three escape cases (both escapes, a scheduled transfer cancelled by an
  escape, the executor down); the SDK watchtower.
- `test/PrivateIndistinguishability.test.ts` (4): the pairs above, the standard account's included.
- `test/WatchtowerService.test.ts` (5): the service against the contracts on the mock FHEVM: a wrong PIN reported at
  submit (also when nobody finalizes it) and not again at finalize; a silent zero and a delivery reported without the
  amount; the duress alarm to the trusted contact only, with no transaction and no new block while it is handled, five
  lines and no amount, and the owner's notices identical to a real-PIN run; a duress PIN private transfer.
- `watchtower/test/watchtower.test.ts` (13): routing, texts without amounts, the config check (a trusted contact equal
  to an owner channel is rejected), the Telegram, e-mail and fake channels.
- `sdk/test/privateMode.test.ts`: routing (including a restricted account), today's sends, the credibility model.
- Web: type check, build, and a read-only browser check of the three screens (standard account, private-mode account,
  setup with private mode on).

## 12. Open questions

Decided since the first version: the 72-hour wait stays strict (a shorter wait for small sends would publish a bit about
each amount); the watchtower service exists ([`watchtower/`](../watchtower/README.md)), runs locally for now, and was run
on Sepolia with the fake channel; when `EncryptedAccountP` needs room for new private features, the module is split.

1. Where the watchtower runs, and who runs it (the owner, a family member, a security company). It needs the account to
   name its address as guardian at creation, the trusted contacts' channels, and a little ETH only if it should restrict
   on a key-only tripwire.
2. The trusted contact has to know in advance what an alarm means and what to do: the service only sends the message.
3. Several devices: key-only routing works from the device that did the setup; another device routes everything to the
   PIN path. The app's L_min is the setup value: tightening the limits with another tool (the app has no such screen)
   would leave it stale.
4. `EncryptedAccountP` is 24,153 bytes (423 left): more private features need another module split.
5. The migration send of ETH pays the F0.16 fee like any PIN-verified ETH send.
