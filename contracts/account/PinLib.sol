// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, externalEuint64, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {AccountStorage as S, Errors, IAccountEvents} from "./AccountStorage.sol";
import {PolicyMath} from "./PolicyMath.sol";

/// @title PinLib — encrypted secret factor (ERC-A draft, Section 13 of the design)
/// @notice External library executed via DELEGATECALL in the account's context.
/// @dev Stored secret: pinH = Enc(first64(Argon2id(PIN, salt))) (Section 13.1). The PIN itself is never stored.
///      Verification (Section 13.2): guess = Enc((h' + c) mod 2^64) where c is bound to the op content;
///      ok = eq(pinH + c, guess). Only the combined bit okAny is ever made publicly decryptable (I3).
library PinLib {
    // ─────────────────────────────── setup ───────────────────────────────

    /// @notice Stores the PIN fingerprint and fills the duress slot.
    /// @dev The duress slot is ALWAYS computed as select(useDuress, candidate, randEuint64()).
    ///      Coprocessor events (FheRand / VerifyInput / FheIfThenElse) expose the dataflow graph publicly,
    ///      so filling the slot "with FHE randomness only when no duress PIN is set" (doc 17.4) would reveal
    ///      which accounts have a duress PIN. With a constant dataflow both cases look identical, and when no
    ///      duress PIN is chosen nobody (not even the client) knows the slot's value.
    function setupPin(
        externalEuint64 fingerprint,
        externalEuint64 duressCandidate,
        externalEbool useDuress,
        bytes calldata proof
    ) external {
        PolicyMath.requireProof(proof);
        S.Layout storage l = S.layout();
        euint64 f = FHE.fromExternal(fingerprint, proof);
        euint64 dc = FHE.fromExternal(duressCandidate, proof);
        ebool ud = FHE.fromExternal(useDuress, proof);
        euint64 d = FHE.select(ud, dc, FHE.randEuint64());
        FHE.allowThis(f);
        FHE.allowThis(d);
        l.pinH = f;
        l.duressH = d;
        l.pinSet = true;
        l.lastPinAt = uint64(block.timestamp);
        emit IAccountEvents.FingerprintChanged();
    }

    /// @notice Validates a new fingerprint (PIN change / forgotten-PIN reset) and keeps it for later use.
    function storeFingerprint(externalEuint64 fingerprint, bytes calldata proof) external returns (bytes32) {
        PolicyMath.requireProof(proof);
        euint64 f = FHE.fromExternal(fingerprint, proof);
        FHE.allowThis(f);
        return euint64.unwrap(f);
    }

    // ─────────────────────────────── verification ───────────────────────────────

    /// @notice Phase 1 of the two-phase verification (Section 13.2).
    /// @dev Order matters: challenge and access checks → input hygiene → score / back-off / restriction (BEFORE the
    ///      result exists, I10) → encrypted comparison → only okAny (and the masked delay-class bit) become publicly
    ///      decryptable.
    /// @param c the challenge the client used; it takes c from the opening receipt (K53).
    function submitGuess(
        uint256 opId,
        uint64 c,
        externalEuint64 guess,
        bytes calldata proof,
        uint8 track,
        address bondPayer,
        uint256 bond
    ) external {
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        // K53 / I23: a guess made against another challenge (e.g. one read from a lagging RPC backend) would be
        // wrong for sure — it is neither evaluated nor counted.
        if (c != PolicyMath.challengeOf(opId, PolicyMath.opHashOf(opId, op))) revert Errors.StaleChallenge();
        if (PolicyMath.status(l, op) != S.Status.NeedsPin) revert Errors.BadStatus();

        // P alone (recovery track) may only freeze or start a delayed recovery (S4, Section 11.3).
        bool strangerOp = PolicyMath.strangerOp(op);
        if ((track == S.TRACK_RECOVERY) != strangerOp) revert Errors.BadTrack();
        if (!strangerOp && op.ownerEpoch != l.ownerEpoch) revert Errors.StaleOp();
        // K54 / I22: CANCEL_ESCAPE is verified on the authenticated lane only (K + D or helper + P) ...
        bool cancelEscape = op.kind == S.Kind.Admin && op.sub == S.A_CANCEL_ESCAPE;
        if (cancelEscape && track != S.TRACK_LANE) revert Errors.BadTrack();
        // ... and while an escape runs it is the only guess accepted at all (I21: anonymous tracks are closed).
        if (l.escapeReadyAt != 0 && !cancelEscape) revert Errors.EscapeActive();
        // K45: with D / helper registered, a PIN-verified key rotation closes the K-track until it runs or is cancelled.
        if (track == S.TRACK_OWNER && l.rotationsPending != 0 && PolicyMath.hasCosigner(l)) revert Errors.RotationLock();

        S.Track storage t = l.tracks[track];
        if (t.pendingOp != 0) revert Errors.SlotBusy();
        uint64 nowTs = uint64(block.timestamp);
        uint64 next = PolicyMath.nextAllowed(l, track);
        if (nowTs < next) revert Errors.Backoff(next);

        // Input hygiene: fresh proof (no handle injection) + no replay. The same input twice in a row on a track is
        // rejected (I5); an input can never count for another op either, because the challenge is bound to the op's
        // content (K53). F0.15: this replaces a one-time-handle mapping that opened a new slot on every guess.
        PolicyMath.requireProof(proof);
        S.Guess storage gs = l.trackGuesses[track];
        bytes32 gh = externalEuint64.unwrap(guess);
        if (gs.inputH == gh) revert Errors.InputReplayed();
        gs.inputH = gh;

        // ── Count BEFORE the result exists (I10): a provisional +1 that only a correct result refunds (K43).
        PolicyMath.normalize(t);
        t.score += 1;
        t.lastAt = nowTs; // also for the owner's correct PIN: nobody can guess right after it (K43)
        t.waitUntil = nowTs + PolicyMath.backoff(PolicyMath.budgetScore(l, track)); // F0.15: stored wait (§5.2 b)
        bool setStrikes;
        if (track == S.TRACK_OWNER && t.score >= PolicyMath.STRIKE_SCORE && (l.restrictedReasons & S.R_STRIKES) == 0) {
            l.restrictedReasons |= S.R_STRIKES;
            setStrikes = true;
            emit IAccountEvents.RestrictionChanged(l.restrictedReasons);
        }

        // ── Encrypted comparison (identical op sequence for every account and every guess).
        euint64 g = FHE.fromExternal(guess, proof);
        ebool okReal = FHE.eq(FHE.add(l.pinH, c), g);
        ebool okDur = FHE.eq(FHE.add(l.duressH, c), g);
        ebool okAny = FHE.or(okReal, okDur);
        // Real PIN takes precedence: if both fingerprints coincide the account behaves normally.
        // (This replaces the doc's on-chain ne(pinH, duressPinH) check and its extra public decryption.)
        ebool isDuress = FHE.and(okDur, FHE.not(okReal));
        FHE.makePubliclyDecryptable(okAny);
        FHE.allowThis(isDuress);
        if (l.guardian != address(0)) FHE.allow(isDuress, l.guardian); // silent alarm (17.3), never public

        gs.okH = ebool.unwrap(okAny);
        gs.duressFlagH = ebool.unwrap(isDuress);
        bool hasBig = op.kind == S.Kind.Outflow;
        if (hasBig) gs.bigH = ebool.unwrap(_bigClass(l, op, okAny)); // a stale bigH stays (no slot reset to zero)
        gs.hasBig = hasBig;
        gs.bondPayer = bondPayer;
        gs.bond = uint96(bond);
        gs.opId = uint64(opId);
        gs.track = track;
        gs.pending = true;
        gs.setStrikes = setStrikes;

        t.pendingOp = uint64(opId);
        op.status = S.Status.Guessing;
        op.guessTrack = track;
        if (op.kind == S.Kind.Admin && op.sub == S.A_CANCEL) {
            // "pause during cancellation" (Section 13.4): the target cannot run while its veto is in flight
            l.ops[abi.decode(op.data, (uint256))].paused = true;
        }
        emit IAccountEvents.GuessSubmitted(opId, track, gs.okH, hasBig ? gs.bigH : bytes32(0));
    }

    /// @dev Delay class of a PIN-path outflow: big = okAny AND (pinSpent + pinCommitted + amount > L_big).
    ///      Masked with okAny so that wrong guesses learn nothing about L_big (improvement over 14.1).
    function _bigClass(S.Layout storage l, S.Op storage op, ebool okAny) private returns (ebool big) {
        S.AssetCfg storage cfg = l.assets[op.target];
        uint256 sc = type(uint256).max;
        // above MAX_AMOUNT (e.g. an unlimited approval): always the long delay; the counters below stay in range
        if (cfg.configured && op.amount <= S.MAX_AMOUNT) {
            PolicyMath.sync(l, cfg);
            PolicyMath.rollEpoch(cfg);
            sc = PolicyMath.scaleUp(PolicyMath.counterOf(cfg.pinSpent) + cfg.pinCommitted + op.amount, cfg.unit);
        }
        if (sc > type(uint64).max) {
            // no threshold configured / out of 64-bit range → always the long delay
            big = FHE.and(okAny, FHE.asEbool(true));
        } else {
            big = FHE.and(okAny, FHE.lt(l.assetEnc[op.target].big, uint64(sc)));
        }
        FHE.makePubliclyDecryptable(big);
    }

    /// @notice Phase 2: verifies the KMS decryption proof and updates counters. Permissionless.
    /// @return ok PIN (or duress PIN) matched.
    /// @return big delay class (outflows only).
    /// @return track the track the guess was made on.
    function finalizeGuess(
        uint256 opId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof
    ) external returns (bool ok, bool big, uint8 track) {
        S.Layout storage l = S.layout();
        track = l.ops[opId].guessTrack;
        S.Guess storage gs = l.trackGuesses[track];
        if (!gs.pending || gs.opId != opId) revert Errors.BadStatus();
        bool hasBig = gs.hasBig;
        bytes32[] memory hs = new bytes32[](hasBig ? 2 : 1);
        hs[0] = gs.okH;
        if (hasBig) hs[1] = gs.bigH;
        FHE.checkSignatures(hs, cleartexts, decryptionProof);
        if (hasBig) {
            (ok, big) = abi.decode(cleartexts, (bool, bool));
        } else {
            ok = abi.decode(cleartexts, (bool));
        }

        gs.pending = false;
        S.Track storage t = l.tracks[track];
        t.pendingOp = 0;
        if (ok) {
            // K43 / I20: refund the provisional +1 only — a correct PIN never lowers the score it found. The attempt
            // time stays: the stored back-off is recomputed from it with the refunded score (§5.2 b).
            PolicyMath.normalize(t);
            if (t.score != 0) t.score -= 1;
            t.waitUntil = t.lastAt + PolicyMath.backoff(PolicyMath.budgetScore(l, track));
            l.lastPinAt = uint64(block.timestamp);
            // R_STRIKES (score-caused) lifts itself if it was this guess's own provisional mark, or if the K-track
            // score is below 3 again. Guardian / owner / P restrictions are lifted only by UNRESTRICT.
            if (
                track != S.TRACK_RECOVERY &&
                (l.restrictedReasons & S.R_STRIKES) != 0 &&
                (gs.setStrikes || PolicyMath.score(l.tracks[S.TRACK_OWNER]) < PolicyMath.STRIKE_SCORE)
            ) {
                l.restrictedReasons &= ~S.R_STRIKES;
                emit IAccountEvents.RestrictionChanged(l.restrictedReasons);
            }
            if (gs.bond > 0) l.refunds[gs.bondPayer] += gs.bond;
        } else if (
            track == S.TRACK_OWNER &&
            (l.restrictedReasons & S.R_STRIKES) == 0 &&
            PolicyMath.score(l.tracks[S.TRACK_OWNER]) >= PolicyMath.STRIKE_SCORE
        ) {
            // §8.3: a wrong K-track result puts R_STRIKES back while the score is ≥ 3. Guesses on different tracks can
            // be in flight together (one slot per track): an UNRESTRICT or a correct guess finalized meanwhile on the
            // lane must not wipe the restriction a wrong K-track guess earns.
            l.restrictedReasons |= S.R_STRIKES;
            emit IAccountEvents.RestrictionChanged(l.restrictedReasons);
        }
        // On failure the +1 stays and the bond stays in the account (each wrong guess pays the owner).
    }

    /// @notice The guess record of `opId` while it is the latest guess on its track (records are reused per track).
    function guessOf(uint256 opId) external view returns (S.Guess memory g) {
        S.Layout storage l = S.layout();
        S.Guess storage gs = l.trackGuesses[l.ops[opId].guessTrack];
        if (opId != 0 && gs.opId == opId) {
            g = gs;
            if (!g.hasBig) g.bigH = bytes32(0);
        }
    }
}
