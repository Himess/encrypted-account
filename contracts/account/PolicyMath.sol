// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccountStorage as S, Errors} from "./AccountStorage.sol";

/// @notice Small internal helpers shared by the account and its libraries (inlined, no FHE).
library PolicyMath {
    uint256 internal constant EPOCH_LENGTH = 1 days;
    /// @notice K43: the wrong-guess score decays by one point per period, on a fixed calendar.
    uint256 internal constant DECAY_PERIOD = 7 days;
    /// @notice K-track score at which the account is restricted (R_STRIKES).
    uint32 internal constant STRIKE_SCORE = 3;
    uint256 internal constant BASE_BOND = 0.001 ether;

    /// @dev Encrypted limits live in "scaled units" so that 18-decimal tokens fit the 64-bit
    ///      FHE comparison: scaled = ceil(amount / unit). Rounding up is conservative (counts more).
    function scaleUp(uint256 amount, uint256 unit) internal pure returns (uint256) {
        return amount == 0 ? 0 : (amount - 1) / unit + 1;
    }

    function currentEpoch() internal view returns (uint64) {
        return uint64(block.timestamp / EPOCH_LENGTH);
    }

    /// @dev Calendar epochs (day buckets). Spent counters reset; reservations and committed PIN
    ///      outflows are not epoch-bound and survive the roll.
    function rollEpoch(S.AssetCfg storage cfg) internal {
        uint64 e = currentEpoch();
        if (cfg.epoch != e) {
            cfg.epoch = e;
            cfg.spent = 0;
            cfg.pinSpent = 0;
            cfg.instantSpent = 0;
        }
    }

    // ─────────────────────────────── K43 / K46 / K56: score, decay, back-off ───────────────────────────────

    /// @notice T2 back-off table (K46): 1–2 wrong → none; n ≥ 3 → 15 min · 4^(n−3), capped at 7 days.
    /// @param n wrong-guess score, including the attempt that is being made.
    function backoff(uint32 n) internal pure returns (uint64) {
        if (n <= 2) return 0;
        if (n >= 8) return 7 days; // 15 min · 4^5 ≈ 10.7 days is above the cap
        return uint64(15 minutes) << (2 * (n - 3));
    }

    function decayNow() internal view returns (uint32) {
        return uint32(block.timestamp / DECAY_PERIOD);
    }

    /// @notice Effective score: the stored score minus the decay boundaries passed since it was normalised.
    /// @dev A fixed calendar (not "7 days after the last attempt") so that the owner's own correct PINs, which
    ///      also move `lastAt`, never hold the decay back.
    function score(S.Track storage t) internal view returns (uint32) {
        uint32 passed = decayNow() - t.decayEpoch;
        return t.score > passed ? t.score - passed : 0;
    }

    function normalize(S.Track storage t) internal {
        t.score = score(t);
        t.decayEpoch = decayNow();
    }

    /// @notice Earliest time of the next attempt on `track`. The anonymous tracks (K-track, recovery track) share
    ///         one budget derived from the sum of their scores and their latest attempt; it is not stored (K56).
    ///         The authenticated lane has its own score and clock.
    function nextAllowed(S.Layout storage l, uint8 track) internal view returns (uint64) {
        if (track == S.TRACK_LANE) {
            S.Track storage t = l.tracks[S.TRACK_LANE];
            return t.lastAt + backoff(score(t));
        }
        S.Track storage k = l.tracks[S.TRACK_OWNER];
        S.Track storage r = l.tracks[S.TRACK_RECOVERY];
        return (k.lastAt > r.lastAt ? k.lastAt : r.lastAt) + backoff(score(k) + score(r));
    }

    /// @notice Recovery-track bond: doubles with every point of the recovery-track score.
    function bondFor(uint32 s) internal pure returns (uint256) {
        return BASE_BOND << (s > 20 ? 20 : s);
    }

    function hasCosigner(S.Layout storage l) internal view returns (bool) {
        return l.deviceSigner != address(0) || l.recoveryHelper != address(0);
    }

    // ─────────────────────────────── op liveness (K54) and counter generation ───────────────────────────────

    function cancellable(S.Status st) internal pure returns (bool) {
        return st == S.Status.Evaluating || st == S.Status.NeedsPin || st == S.Status.Guessing || st == S.Status.Delayed;
    }

    /// @notice Effective status. An escape cancels every pending op opened before it (K54) — in O(1), by bumping
    ///         `escEpoch` — so a thief holding K cannot make the panic button unaffordable by opening many ops.
    function status(S.Layout storage l, S.Op storage op) internal view returns (S.Status st) {
        st = op.status;
        if (op.escEpoch != l.escEpoch && cancellable(st)) st = S.Status.Cancelled;
    }

    /// @notice Recovery and Freeze ops belong to "P alone" and survive an owner change; every other op dies with K.
    function strangerOp(S.Op storage op) internal view returns (bool) {
        return op.kind == S.Kind.Recovery || (op.kind == S.Kind.Admin && op.sub == S.A_FREEZE);
    }

    function live(S.Layout storage l, S.Op storage op) internal view returns (bool) {
        return op.escEpoch == l.escEpoch && (op.ownerEpoch == l.ownerEpoch || strangerOp(op));
    }

    /// @notice Generation of the `reserved` / `pinCommitted` amounts: an owner change or an escape orphans them.
    function gen(S.Layout storage l) internal view returns (uint64) {
        return (uint64(l.ownerEpoch) << 32) | l.escEpoch;
    }

    /// @notice Drops the amounts of orphaned ops before the counters are read or written.
    function sync(S.Layout storage l, S.AssetCfg storage cfg) internal {
        uint64 g = gen(l);
        if (cfg.gen != g) {
            cfg.gen = g;
            cfg.reserved = 0;
            cfg.pinCommitted = 0;
        }
    }

    /// @notice Whether the op's reserved / committed amount belongs to the current counter generation.
    function counted(S.Layout storage l, S.Op storage op) internal view returns (bool) {
        return op.escEpoch == l.escEpoch && op.ownerEpoch == l.ownerEpoch;
    }

    /// @notice Challenge c of an op; the client encrypts (h + c) mod 2^64 (Section 13.2).
    function challengeOf(uint256 opId, bytes32 opHash) internal view returns (uint64) {
        return uint64(uint256(keccak256(abi.encode(S.CHALLENGE_TAG, block.chainid, address(this), opId, opHash))));
    }

    /// @notice Optional PIN pulse (K26): K-only spending is valid for `pulsePeriod` after the last PIN success.
    function pulseOk(S.Layout storage l) internal view returns (bool) {
        return l.pulsePeriod == 0 || block.timestamp <= uint256(l.lastPinAt) + l.pulsePeriod;
    }

    /// @dev Every user-supplied ciphertext MUST come with a fresh input proof.
    ///      Since fhevm-solidity 0.11, `FHE.fromExternal(handle, "")` silently accepts *any* handle the
    ///      caller is already allowed to use. In a self-call / multicall context that includes handles the
    ///      account computed itself (e.g. Enc(pinH + c)), which would turn a PIN guess into a PIN bypass.
    function requireProof(bytes calldata proof) internal pure {
        if (proof.length == 0) revert Errors.EmptyInputProof();
    }
}
