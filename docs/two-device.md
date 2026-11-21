# Two devices: the key on one, the PIN on the other

The account's PIN is a second factor, but on a single device it shares that device with the key: malware that takes
over the device can read the key and watch the PIN being typed. With two devices the key stays on one (a computer or a
hardware wallet) and the PIN is typed on the other (a phone). Taking over one device then yields the key or the PIN, not
both. It is recommended and never required: an account works the same with one device.

The contract has supported this from the start: the **authenticated lane** (`TRACK_LANE`). A lane guess is sent by K
(`submitGuessWithCosign`) together with a signature of the second device D (or the recovery helper) over
`(opId, guess handle)`. It has its own wrong-guess score and clock, outside the K-track's shared budget, and needs no bond.

## The flow

| Step | Computer (holds K) | Phone (holds the device key D) |
|---|---|---|
| Pairing | shows a link / QR (`/app#pair`); registers the phone's device address: at setup (`setupRoles`, before arming), or later with the PIN (`A_SET_DEVICE`, settings delay) | makes its device key (kept in the browser) and shows its address |
| An op | opens it (e.g. `requestTransfer`), shows a link / QR `/app#approve=<account>:<opId>` | reads the op from the chain (recipient, asset, amount, fee, delay), **recomputes its challenge** from the op's content and checks it against the contract's |
| PIN | | the PIN is typed here; Argon2id → fingerprint h; Enc((h + c) mod 2⁶⁴) for **(account, K's address)**; signs `(opId, guess handle)` with D |
| Approval | the phone's code is pasted here; submits `submitGuessWithCosign` with K; the yes / no result is decrypted and finalized as for any guess | shows the approval code (copy / share) |

The PIN and the fingerprint never reach the computer. The FHE input is bound to (account, the address that sends it),
and K sends it, so the phone builds it for K's address; it needs no key for that. Tested: an input made for the phone's
own address is refused, and a code for one op is useless for another (`test/TwoDevice.test.ts`). The SDK helpers are in
[`sdk/src/lane.ts`](../sdk/src/lane.ts) (challenge recomputation, the lane message, the approval code).

## The optional two-device setting

`A_SET_LANE_ONLY`: with a second device or helper registered, these ops accept **only lane guesses**:

- every generic call and ERC-1271 approval (`A_APPROVE_HASH`);
- every loosening change: limits, PIN pulse, recovery on, auto-known, instant budget, the B variant's open limit;
- every private transfer of private mode (always in the long class);
- a transfer in the long class (above L_big): its class is known only after the guess, so a correct K-track PIN leaves
  the op open (`LaneRequired`) for a lane guess;
- turning the setting off.

Turning it on is the key alone, at once (it only tightens; `openAdmin` applies it and opens no op). Turning it off is an
op on the lane, then `max(loosen, 72 h)`.

**No lock-out.** Losing the phone does not lock the owner out. Changing the second device (or the helper) stays possible
on the K-track with the PIN; with the setting on and without the device, the change takes the long no-device delay
(`recoveryNoDevice`, 30 days by default), and the watchtower tells the owner (a device change opened, then the
PIN-approved op with its run time). After that the new phone works on the lane. With no second device left at all, the
setting no longer binds (there would be no lane to use).

## What it does not do

- The phone's device key lives in its browser storage. A passkey (WebAuthn, through an ERC-1271 wrapper as D) would keep
  it in the phone's secure hardware; not built.
- There is no relay between the two devices: the approval code is carried by hand (copy, share, or a chat with oneself).
- Small transfers, settings ops and admin ops outside the list above still accept the K-track: without the setting, two
  devices keep the PIN away from the key's device, but the key's device can still be used with the PIN.
- Both devices taken over is the single-device case.
