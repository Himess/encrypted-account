// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccountStorage as S, Errors, IAccountEvents} from "./AccountStorage.sol";
import {PolicyMath} from "./PolicyMath.sol";
import {PolicyLib} from "./PolicyLib.sol";
import {IFeeConfig} from "../fee/IFeeConfig.sol";

interface IAutoKnownHook {
    function autoKnownHook(bool spenders, address who) external;
}

/// @title OpsLib — pending-op state machine (Section 12.2 `PendingOps`), delays and execution.
/// @notice External library executed via DELEGATECALL in the account's context.
library OpsLib {
    using SafeERC20 for IERC20;

    // ─────────────────────────────── K-only outflow, phase 2 ───────────────────────────────

    function finalizeEvaluation(uint256 opId, bytes calldata cleartexts, bytes calldata decryptionProof) external {
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        // An escape cancels the op (K54): it never executes, whatever `ok` says.
        if (PolicyMath.status(l, op) != S.Status.Evaluating) revert Errors.BadStatus();
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = op.h0;
        FHE.checkSignatures(hs, cleartexts, decryptionProof);
        bool ok = abi.decode(cleartexts, (bool));
        emit IAccountEvents.EvaluationFinalized(opId, ok);
        if (op.ownerEpoch != l.ownerEpoch) {
            // orphaned by an owner change: its reservation was dropped together with the counter generation
            op.status = S.Status.Cancelled;
            emit IAccountEvents.OpCancelled(opId);
            return;
        }

        S.AssetCfg storage cfg = l.assets[op.target];
        PolicyMath.sync(l, cfg);
        cfg.reserved -= uint112(op.amount); // fits: PolicyLib.evaluate reserved it only within uint112
        // A restriction, an expired pulse or a guardian pause that happened meanwhile also stops K-only execution.
        if (ok && l.restrictedReasons == 0 && PolicyMath.pulseOk(l) && !PolicyMath.paused(l, op, opId)) {
            PolicyMath.rollEpoch(cfg);
            if (cfg.epoch == op.epochDay) cfg.spent = PolicyMath.counterAdd(cfg.spent, op.amount);
            op.status = S.Status.Executed;
            _performOutflow(op.sub, op.target, op.counterparty, op.amount);
            emit IAccountEvents.OpExecuted(opId);
        } else {
            op.status = S.Status.NeedsPin; // "PIN required": the owner may continue on the PIN path
        }
    }

    // ─────────────────────────────── after a PIN guess ───────────────────────────────

    function afterGuess(uint256 opId, bool ok, bool big, uint8 track) external {
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        if (op.status != S.Status.Guessing) {
            emit IAccountEvents.GuessFinalized(opId, track, ok, 0); // op was cancelled meanwhile
            return;
        }
        bool cancelOp = op.kind == S.Kind.Admin && op.sub == S.A_CANCEL;
        bool alive = PolicyMath.live(l, op);
        if (!ok || !alive) {
            if (cancelOp) l.ops[abi.decode(op.data, (uint256))].paused = false;
            if (alive) {
                op.status = S.Status.NeedsPin;
            } else {
                // cancelled by an escape (K54) or orphaned by an owner change while the guess was in flight
                op.status = S.Status.Cancelled;
                emit IAccountEvents.OpCancelled(opId);
            }
            emit IAccountEvents.GuessFinalized(opId, track, ok, 0);
            return;
        }
        bool lane = track == S.TRACK_LANE;
        if (big && op.kind == S.Kind.Outflow && !lane && l.laneOnly && PolicyMath.hasCosigner(l)) {
            // the two-device setting: a transfer in the long class needs the lane; the op stays open for a lane guess
            op.status = S.Status.NeedsPin;
            emit IAccountEvents.LaneRequired(opId);
            emit IAccountEvents.GuessFinalized(opId, track, true, 0);
            return;
        }
        uint64 d = delayFor(l, op, big);
        // without the second device (K-track, setting on): a device or helper change takes the long no-device delay
        if (!lane && l.laneOnly && op.kind == S.Kind.Admin && (op.sub == S.A_SET_DEVICE || op.sub == S.A_SET_HELPER) && d < l.delays.recoveryNoDevice) {
            d = l.delays.recoveryNoDevice;
        }
        uint64 readyAt = uint64(block.timestamp) + d;
        op.status = S.Status.Delayed;
        op.readyAt = readyAt;
        if (op.kind == S.Kind.Outflow) {
            S.AssetCfg storage cfg = l.assets[op.target];
            PolicyMath.sync(l, cfg);
            cfg.pinCommitted += uint128(PolicyMath.capped(op.amount));
        } else if (op.kind == S.Kind.Admin && op.sub == S.A_ROTATE_OWNER) {
            l.rotationsPending += 1; // K45: closes the K-track (if D / helper exists) until it runs or is cancelled
        }
        emit IAccountEvents.GuessFinalized(opId, track, true, readyAt);
        // an op the guardian paused waits for executeOp after the pause, even with no delay of its own
        if (readyAt == block.timestamp && op.kind == S.Kind.Admin && !PolicyMath.paused(l, op, opId)) {
            op.status = S.Status.Executed;
            _execute(l, opId, op, address(0)); // admin ops carry no fee
        }
    }

    // ─────────────────────────────── execution ───────────────────────────────

    /// @param feeConfig F0.16: where the fee bound to a PIN-verified transfer goes (its feeRecipient)
    function executeOp(uint256 opId, address feeConfig) external {
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        if (PolicyMath.status(l, op) != S.Status.Delayed) revert Errors.BadStatus(); // escape-cancelled → Cancelled
        if (block.timestamp < op.readyAt) revert Errors.NotReady();
        if (op.paused || PolicyMath.paused(l, op, opId)) revert Errors.OpPaused();
        if (op.kind == S.Kind.Recovery) {
            if (l.escapeReadyAt != 0) revert Errors.EscapeActive(); // escape pre-empts recovery (16.7)
            if (!l.recoveryEnabled) revert Errors.RecoveryDisabled();
        } else if (op.ownerEpoch != l.ownerEpoch) {
            revert Errors.StaleOp(); // ops of a rotated / recovered key die with it
        }
        op.status = S.Status.Executed;
        _execute(l, opId, op, feeConfig);
    }

    function _execute(S.Layout storage l, uint256 opId, S.Op storage op, address feeConfig) private {
        if (op.kind == S.Kind.Outflow) {
            S.AssetCfg storage cfg = l.assets[op.target];
            PolicyMath.sync(l, cfg);
            uint256 c = PolicyMath.capped(op.amount);
            cfg.pinCommitted -= uint128(c);
            PolicyMath.rollEpoch(cfg);
            cfg.pinSpent = PolicyMath.counterAdd(cfg.pinSpent, c);
            // F0.16: the fee approved with the PIN, on top of the amount. Not enough for both → revert, the op stays
            // delayed and can run later. The payee always receives exactly `amount`.
            uint256 fee = op.fee;
            if (fee != 0) _requireFunds(op.sub, op.target, op.amount + fee);
            _performOutflow(op.sub, op.target, op.counterparty, op.amount);
            if (fee != 0) _payFee(opId, op.sub, op.target, fee, feeConfig);
            if (l.autoKnown) {
                if (l.openMode) {
                    // B (F0.11): "after the first PIN-verified send" — a plain list write, no FHE
                    openKnownAdd(l, op.sub == S.OUT_APPROVE, op.counterparty);
                } else {
                    // best effort: an FHE outage must never block an already verified outflow
                    try IAutoKnownHook(address(this)).autoKnownHook(op.sub == S.OUT_APPROVE, op.counterparty) {} catch {}
                }
            }
        } else if (op.kind == S.Kind.Call) {
            // F0.16: an ETH-carrying call pays the fee bound at opening, exactly like an ETH transfer
            uint256 fee = op.callFee;
            if (fee != 0) _requireFunds(S.OUT_ETH, address(0), op.amount + fee);
            (bool s, bytes memory ret) = op.target.call{value: op.amount}(op.data);
            if (!s) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            if (fee != 0) _payFee(opId, S.OUT_ETH, address(0), fee, feeConfig);
        } else if (op.kind == S.Kind.Recovery) {
            if (op.counterparty == l.escapeAddress) {
                _void(l, opId, op); // E_addr changed to this key meanwhile (role separation)
                return;
            }
            _setOwner(l, op.counterparty);
        } else if (op.kind == S.Kind.PinReset) {
            _setFingerprint(l, op.h0);
        } else if (!_executeAdmin(l, op)) {
            _void(l, opId, op);
            return;
        }
        emit IAccountEvents.OpExecuted(opId);
    }

    /// @dev Role separation (E_addr ≠ K, E_addr ≠ guardian) is checked when an op is opened and again when it runs,
    ///      because two pending ops can conflict (e.g. SET_ESCAPE(X) and SET_GUARDIAN(X)). The loser is cancelled
    ///      instead of reverting: it may run inside a finalize.
    function _void(S.Layout storage l, uint256 opId, S.Op storage op) private {
        if (op.kind == S.Kind.Admin && op.sub == S.A_ROTATE_OWNER && PolicyMath.counted(l, op) && l.rotationsPending != 0) {
            l.rotationsPending -= 1; // K45: a cancelled rotation releases the lock
        }
        op.status = S.Status.Cancelled;
        emit IAccountEvents.OpCancelled(opId);
    }

    /// @return applied false if the action would break role separation (the op is then cancelled)
    function _executeAdmin(S.Layout storage l, S.Op storage op) private returns (bool applied) {
        uint8 a = op.sub;
        if (a == S.A_CANCEL) {
            _cancel(l, abi.decode(op.data, (uint256)));
        } else if (a == S.A_UNRESTRICT) {
            l.restrictedReasons = 0;
            emit IAccountEvents.RestrictionChanged(0);
        } else if (a == S.A_FREEZE) {
            l.restrictedReasons |= S.R_PIN;
            emit IAccountEvents.RestrictionChanged(l.restrictedReasons);
        } else if (a == S.A_ROTATE_OWNER) {
            address k = abi.decode(op.data, (address));
            if (k == l.escapeAddress) return false;
            _setOwner(l, k);
        } else if (a == S.A_PIN_CHANGE) {
            _setFingerprint(l, op.h0);
        } else if (a == S.A_SET_LIMITS) {
            (address asset, uint256 unit) = abi.decode(op.data, (address, uint256));
            PolicyLib.applyLimits(asset, unit, op.h0, op.h1, op.h2);
        } else if (a == S.A_RESET_TRIP) {
            PolicyLib.resetTrip(abi.decode(op.data, (address)));
        } else if (a == S.A_ADD_KNOWN_R || a == S.A_ADD_KNOWN_S) {
            if (l.openMode) openKnownAdd(l, a == S.A_ADD_KNOWN_S, abi.decode(op.data, (address)));
            else PolicyLib.writeKnown(a == S.A_ADD_KNOWN_S, abi.decode(op.data, (uint256)), op.h0);
        } else if (a == S.A_SET_OPEN_LIMIT) {
            (address asset, uint256 limit) = abi.decode(op.data, (address, uint256));
            l.assets[asset].openLimit = limit;
            emit IAccountEvents.OpenLimitSet(asset, limit);
        } else if (a == S.A_SET_GUARDIAN) {
            address g = abi.decode(op.data, (address));
            if (g == l.escapeAddress) return false;
            l.guardian = g;
        } else if (a == S.A_SET_DEVICE) {
            l.deviceSigner = abi.decode(op.data, (address));
        } else if (a == S.A_SET_HELPER) {
            l.recoveryHelper = abi.decode(op.data, (address));
        } else if (a == S.A_SET_ESCAPE) {
            // consent of the new E_addr was verified at opening (K55); its signing time is the last verification
            (address e, uint64 consentAt) = abi.decode(op.data, (address, uint64));
            if (e == l.owner || e == l.guardian) return false;
            l.escapeAddress = e;
            l.escapeVerifiedAt = consentAt;
            l.escapeNonce += 1;
            emit IAccountEvents.EscapeAddressChanged(e, l.escapeNonce);
        } else if (a == S.A_SET_PULSE) {
            l.pulsePeriod = abi.decode(op.data, (uint32));
        } else if (a == S.A_SET_RECOVERY) {
            l.recoveryEnabled = abi.decode(op.data, (bool));
        } else if (a == S.A_SET_AUTOKNOWN) {
            l.autoKnown = abi.decode(op.data, (bool));
        } else if (a == S.A_APPROVE_HASH) {
            l.approvedHashes[abi.decode(op.data, (bytes32))] = true;
        } else if (a == S.A_SET_INSTANT) {
            (address asset, uint256 budget) = abi.decode(op.data, (address, uint256));
            l.assets[asset].instantBudget = budget;
        } else if (a == S.A_CANCEL_ESCAPE) {
            // the ops the escape cancelled stay cancelled (their escEpoch is behind for good)
            l.escapeReadyAt = 0;
            l.escapeTo = address(0);
            emit IAccountEvents.EscapeCancelled();
        } else if (a == S.A_SET_OWNER_BOND) {
            uint256 base = abi.decode(op.data, (uint256));
            l.ownerBondUnits = PolicyMath.ownerBondUnits(base);
            emit IAccountEvents.OwnerBondSet(base);
        } else if (a == S.A_UNPAUSE) {
            uint256 t = abi.decode(op.data, (uint256));
            l.pausedAt[t] = 1; // lifted; and never again (one pause per op)
            emit IAccountEvents.PauseLifted(t);
        } else if (a == S.A_SET_LANE_ONLY) {
            l.laneOnly = false; // only "off" is ever an op (on is applied at once by openAdmin)
            emit IAccountEvents.LaneOnlySet(false);
        }
        return true;
    }

    /// @notice Authority matrix (Section 11.3) — delay classes. Values come from the per-account Delays.
    function delayFor(S.Layout storage l, S.Op storage op, bool big) internal view returns (uint64) {
        S.Delays storage d = l.delays;
        if (op.kind == S.Kind.Outflow) return big ? d.bigTransfer : d.pinTransfer;
        if (op.kind == S.Kind.Call) return op.amount > 0 && d.bigTransfer > d.genericCall ? d.bigTransfer : d.genericCall;
        if (op.kind == S.Kind.Recovery) {
            return op.viaDevice || l.deviceSigner == address(0) ? d.recovery : d.recoveryNoDevice;
        }
        uint8 a = op.sub;
        if (a == S.A_CANCEL || a == S.A_UNRESTRICT || a == S.A_FREEZE || a == S.A_CANCEL_ESCAPE || a == S.A_RESET_TRIP || a == S.A_UNPAUSE) return 0;
        if (
            a == S.A_ROTATE_OWNER ||
            a == S.A_PIN_CHANGE ||
            a == S.A_SET_GUARDIAN ||
            a == S.A_SET_DEVICE ||
            a == S.A_SET_HELPER ||
            a == S.A_SET_OWNER_BOND
        ) {
            return d.settings;
        }
        if (a == S.A_ADD_KNOWN_R || a == S.A_ADD_KNOWN_S) return d.knownAdd;
        if (a == S.A_SET_ESCAPE) return d.escapeChange;
        if (a == S.A_APPROVE_HASH) return d.genericCall;
        if (a == S.A_SET_LANE_ONLY) return d.loosen > PolicyMath.LANE_ONLY_OFF_DELAY ? d.loosen : PolicyMath.LANE_ONLY_OFF_DELAY;
        return d.loosen; // SET_LIMITS, SET_PULSE, SET_RECOVERY, SET_AUTOKNOWN, SET_INSTANT
    }

    // ─────────────────────────────── guardian pause ───────────────────────────────

    /// @notice The guardian holds a pending op back: it then runs no earlier than GUARDIAN_PAUSE after the later of its own
    ///         readyAt and the pause; once per op (e.g. after a silent duress alarm, by the trusted contact's decision; never
    ///         automatically at the PIN entry). It moves no funds and changes no setting. The owner lifts it on the lane
    ///         (A_UNPAUSE: K + second device or helper + PIN). Any pending op, so a pause proves nothing about which PIN
    ///         approved it.
    function guardianPause(uint256 opId) external {
        S.Layout storage l = S.layout();
        if (msg.sender != l.guardian || msg.sender == address(0)) revert Errors.NotAuthorized();
        if (!PolicyMath.cancellable(PolicyMath.status(l, l.ops[opId]))) revert Errors.BadStatus();
        if (l.pausedAt[opId] != 0) revert Errors.OpPaused();
        l.pausedAt[opId] = uint64(block.timestamp);
        emit IAccountEvents.GuardianPaused(opId, uint64(block.timestamp));
    }

    // ─────────────────────────────── cancellation ───────────────────────────────

    function cancel(uint256 id) external {
        S.Layout storage l = S.layout();
        if (!PolicyMath.cancellable(PolicyMath.status(l, l.ops[id]))) revert Errors.BadStatus();
        _cancel(l, id);
    }

    function _cancel(S.Layout storage l, uint256 id) private {
        S.Op storage t = l.ops[id];
        S.Status st = PolicyMath.status(l, t);
        if (!PolicyMath.cancellable(st)) return; // never revert inside a finalize
        if (PolicyMath.counted(l, t)) {
            if (st == S.Status.Evaluating || (st == S.Status.Delayed && t.kind == S.Kind.Outflow)) {
                S.AssetCfg storage cfg = l.assets[t.target];
                PolicyMath.sync(l, cfg);
                if (st == S.Status.Evaluating) cfg.reserved -= uint112(t.amount);
                else cfg.pinCommitted -= uint128(PolicyMath.capped(t.amount));
            } else if (st == S.Status.Delayed && t.kind == S.Kind.Admin && t.sub == S.A_ROTATE_OWNER && l.rotationsPending != 0) {
                l.rotationsPending -= 1; // K45: the lock opens when the last pending rotation is cancelled
            }
        }
        t.status = S.Status.Cancelled;
        t.paused = false;
        emit IAccountEvents.OpCancelled(id);
    }

    // ─────────────────────────────── state helpers ───────────────────────────────

    function _setOwner(S.Layout storage l, address newOwner) private {
        l.owner = newOwner;
        l.ownerEpoch += 1; // every pending op of the previous key becomes stale (its reserved amount is dropped)
        l.rotationsPending = 0; // K45: the other pending rotations died with the old key
        // K56: the old K is worthless, and so is its K-track score; the recovery-track score is kept.
        S.Track storage k = l.tracks[S.TRACK_OWNER];
        k.score = 0;
        k.decayEpoch = PolicyMath.decayNow();
        k.waitUntil = 0; // F0.15: the old key's stored back-off does not bind the new key
        emit IAccountEvents.OwnerChanged(newOwner, l.ownerEpoch);
    }

    /// @dev K43: a PIN change or reset keeps every score (a thief cannot launder his wrong guesses through it).
    function _setFingerprint(S.Layout storage l, bytes32 h) private {
        l.pinH = euint64.wrap(h);
        emit IAccountEvents.FingerprintChanged();
    }

    // ─────────────────────────────── B variant: open list (F0.11) ───────────────────────────────

    /// @notice Adds `who` to the open list, active at once (a K+P op's own delay is its activation delay). An address
    ///         already on the list keeps its entry. Public by design: OpenKnownChanged reveals every entry.
    function openKnownAdd(S.Layout storage l, bool spenders, address who) internal {
        mapping(address => uint64) storage m = spenders ? l.openKnownS : l.openKnownR;
        if (m[who] != 0) return;
        m[who] = uint64(block.timestamp);
        emit IAccountEvents.OpenKnownChanged(spenders, who, uint64(block.timestamp));
    }

    // ─────────────────────────────── value movement ───────────────────────────────

    function performOutflow(uint8 sub, address asset, address cp, uint256 amount) external {
        _performOutflow(sub, asset, cp, amount);
    }

    function _performOutflow(uint8 sub, address asset, address cp, uint256 amount) private {
        if (sub == S.OUT_ETH) {
            (bool s, ) = payable(cp).call{value: amount}("");
            if (!s) revert Errors.TransferFailed();
        } else if (sub == S.OUT_ERC20) {
            IERC20(asset).safeTransfer(cp, amount);
        } else {
            IERC20(asset).forceApprove(cp, amount);
        }
    }

    /// @dev F0.16: amount + fee must be there before anything moves (ETH balance, or the token balance).
    function _requireFunds(uint8 sub, address asset, uint256 needed) private view {
        uint256 bal = sub == S.OUT_ETH ? address(this).balance : IERC20(asset).balanceOf(address(this));
        if (bal < needed) revert Errors.InsufficientBalance(needed);
    }

    /// @dev F0.16: pays the bound fee to FeeConfig's recipient. If FeeConfig or the transfer to the recipient fails, the
    ///      fee is skipped and the verified transfer still completes (the user is never blocked by the fee module).
    function _payFee(uint256 opId, uint8 sub, address asset, uint256 fee, address fc) private {
        address to;
        if (fc != address(0)) {
            try IFeeConfig(fc).feeRecipient{gas: 30_000}() returns (address r) {
                to = r;
            } catch {}
        }
        bool ok;
        if (to != address(0) && to != address(this)) {
            if (sub == S.OUT_ETH) {
                (ok, ) = payable(to).call{value: fee, gas: 50_000}("");
            } else {
                (bool s, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, fee)));
                ok = s && (ret.length == 0 ? asset.code.length != 0 : (ret.length == 32 && abi.decode(ret, (bool))));
            }
        }
        if (ok) emit IAccountEvents.FeePaid(opId, to, fee);
        else emit IAccountEvents.FeeSkipped(opId, fee);
    }

    /// @notice Escape sweep. Deliberately contains no FHE / ACL call (works while Zama is down or the account
    ///         is on the ACL deny-list).
    function sweep(address[] calldata tokens, address to) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[i]).safeTransfer(to, bal);
        }
        uint256 eth = address(this).balance;
        if (eth > 0) {
            (bool s, ) = payable(to).call{value: eth}("");
            if (!s) revert Errors.TransferFailed();
        }
    }
}
