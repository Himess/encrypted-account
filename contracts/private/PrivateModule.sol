// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, eaddress, externalEuint64, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC7984} from "../vendor/openzeppelin-confidential/interfaces/IERC7984.sol";
import {AccountStorage as S, Errors, IAccountEvents} from "../account/AccountStorage.sol";
import {PolicyMath} from "../account/PolicyMath.sol";
import {OpenLib} from "../account/OpenLib.sol";
import {PrivateStorage as P, IPrivateHooks} from "./PrivateStorage.sol";

/// @title PrivateModule — the optional private mode for ERC-7984 tokens ("deniable account", design doc v0.4 Phase 2)
/// @notice Runs only through DELEGATECALL from an EncryptedAccountP account, so it has that account's storage, ACL identity
///         and msg.sender. Paths:
///  - privateTransfer: K alone, ONE transaction, nothing decrypted. Hidden limit, sticky tripwire and known list are applied
///    with `select`; a transfer that breaks a rule moves an encrypted zero (silent zero). The watchtower learns the outcome
///    from the counter it is allowed to read; K does not.
///  - openPrivateView + PIN: the balance becomes visible to K as a fresh encrypted snapshot (K alone never sees it).
///  - openPrivateTransfer + PIN: a transfer of an encrypted amount, always in the long delay class (≥ 72 h, §17.1).
///  - openPrivateReset / openSetDuress + PIN, and PIN changes (A_PIN_CHANGE) of the account: duress-aware (§17.6).
///  - executeEscapeConfidential: after an escape, the whole encrypted balance of each private token goes to the escape
///    address. It needs the FHE host contracts on-chain; the account's ETH / ERC-20 escape (executeEscape) does not.
///  Under the duress PIN every PIN path runs the same FHE operations, writes the same slots and emits the same events as
///  under the real PIN; only encrypted values differ. The duress PIN works on the balance minus the hidden amount as if
///  that were the whole balance, and K alone never reaches the hidden amount either, so deposits, K-only sends and duress
///  sends show in a duress view exactly as they would in a real one.
contract PrivateModule is IPrivateHooks, ReentrancyGuardTransient {
    /// @notice Semantics of this module, for clients: 2 = the duress PIN keeps a hidden amount out of view (1, the first
    ///         Sepolia build, capped the duress view at a decoy amount instead).
    uint256 public constant PRIVATE_MODE_VERSION = 2;
    /// @notice The EntryPoint of the account implementation that uses this module (K may also act through it).
    address public immutable entryPoint;
    address private immutable self;

    event PrivateAssetSet(address indexed token);
    /// @param spent the K-only counter after the transfer, allowed to the guardian: its change is what really moved, and
    ///        TRIPPED (2^64 − 1) means the tripwire fired. `epoch` is the counter's day, so a watcher can tell a day
    ///        restart from a transfer that moved nothing.
    event PrivateTransfer(address indexed token, address indexed to, bytes32 spent, uint64 epoch);
    /// @param result the snapshot handle (view), the moved handle (transfer), or zero
    event PrivateOpExecuted(uint256 indexed opId, uint8 sub, bytes32 result);
    event PrivateLimitsTightened(address indexed token);
    event PrivateEscape(address indexed token, address indexed to, bytes32 moved);

    constructor(address ep) {
        entryPoint = ep;
        self = address(this);
    }

    /// @dev The module's own storage is never used: only DELEGATECALL from an account is meaningful.
    modifier viaAccount() {
        if (address(this) == self) revert Errors.NotAuthorized();
        _;
    }

    // ─────────────────────────────── setup ───────────────────────────────

    /// @notice Setup (before arming): turns on the private paths for an ERC-7984 token, with its own encrypted limits and
    ///         the hidden amount. The account must have been created with bigTransfer ≥ 72 h (§17.1).
    /// @param hidden the part of the balance the duress PIN never shows or moves, client-encrypted in every account so the
    ///        dataflow does not show whether a duress PIN exists. Without a duress PIN it must be 0: K alone never moves the
    ///        hidden amount either. Capped at MAX_LIMIT.
    function privateSetupAsset(address token, externalEuint64 lmin, externalEuint64 lmax, externalEuint64 hidden, bytes calldata proof)
        external
        viaAccount
    {
        S.Layout storage l = S.layout();
        if (l.armed) revert Errors.AlreadyArmed();
        _onlyK(l);
        if (token == address(0) || l.assets[token].configured) revert Errors.InvalidParams(); // never a public asset too
        if (l.delays.bigTransfer < P.MIN_BIG_DELAY) revert Errors.InvalidParams();
        P.Asset storage a = P.layout().assets[token];
        if (a.configured) revert Errors.InvalidParams();
        PolicyMath.requireProof(proof);
        euint64 lo = FHE.min(FHE.fromExternal(lmin, proof), P.MAX_LIMIT);
        euint64 hi = FHE.max(FHE.min(FHE.fromExternal(lmax, proof), P.MAX_LIMIT), lo);
        euint64 h = FHE.min(FHE.fromExternal(hidden, proof), P.MAX_LIMIT);
        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(lo);
        FHE.allowThis(hi);
        FHE.allowThis(h);
        FHE.allowThis(zero);
        a.configured = true;
        a.epoch = PolicyMath.currentEpoch();
        a.lmin = lo;
        a.l = hi;
        a.hidden = h;
        a.spent = zero;
        euint64 tau = _drawTau(a);
        FHE.allowThis(tau);
        a.tau = tau;
        _cleanAA();
        emit PrivateAssetSet(token);
    }

    // ─────────────────────────────── K alone: one transaction ───────────────────────────────

    /// @notice K-only private transfer, synchronous:
    ///   room = max(tau, spent) − spent;  fits = amount ≤ room;  visible = amount + hidden ≤ balance
    ///   pass = isIn(to, recipients) AND fits AND visible
    ///   moved = token.transfer(to, select(pass, amount, 0));  spent = fits ? spent + moved : TRIPPED
    /// A tripped counter (TRIPPED ≥ tau) leaves no room, so the wire stays fired until a PIN-verified reset. An amount that
    /// would reach into the hidden amount moves zero without tripping, like a transfer above a balance: K alone never moves
    /// what the duress PIN keeps hidden, so a coercer holding K cannot probe it. Nothing is decrypted; only the guardian may
    /// read the new counter, so K never learns whether a transfer passed.
    function privateTransfer(address token, address to, externalEuint64 amount, bytes calldata proof) external viaAccount nonReentrant returns (bytes32) {
        S.Layout storage l = S.layout();
        _onlyK(l);
        if (!l.armed) revert Errors.NotArmed();
        if (l.escapeReadyAt != 0) revert Errors.EscapeActive(); // I21: no K-only movement during an escape
        if (l.restrictedReasons != 0 || !PolicyMath.pulseOk(l)) revert Errors.NotAuthorized();
        if (to == address(0) || to == address(this)) revert Errors.InvalidParams();
        P.Asset storage a = P.layout().assets[token];
        if (!a.configured) revert Errors.InvalidParams();
        PolicyMath.requireProof(proof);
        euint64 amt = FHE.fromExternal(amount, proof);
        _roll(a);
        euint64 spent = a.spent;
        euint64 room = FHE.sub(FHE.max(a.tau, spent), spent);
        ebool fits = FHE.le(amt, room);
        // no overflow where it matters: when `fits`, amount ≤ room ≤ tau < 2^63, and hidden ≤ MAX_LIMIT = 2^62
        ebool visible = FHE.le(FHE.add(amt, a.hidden), IERC7984(token).confidentialBalanceOf(address(this)));
        ebool pass = FHE.and(FHE.isIn(FHE.asEaddress(to), _recipients(l)), FHE.and(fits, visible));
        euint64 send = FHE.select(pass, amt, FHE.asEuint64(0));
        FHE.allowTransient(send, token);
        euint64 moved = IERC7984(token).confidentialTransfer(to, send);
        euint64 next = FHE.select(fits, FHE.add(spent, moved), FHE.asEuint64(P.TRIPPED));
        FHE.allowThis(next);
        if (l.guardian != address(0)) FHE.allow(next, l.guardian); // the watchtower's view: what moved, and the tripwire
        a.spent = next;
        _cleanAA();
        emit PrivateTransfer(token, to, euint64.unwrap(next), a.epoch);
        return euint64.unwrap(moved);
    }

    /// @notice K alone, immediate: the limits can only get tighter (encrypted min, as PolicyLib.tighten).
    function privateTighten(address token, externalEuint64 cap, bytes calldata proof) external viaAccount nonReentrant {
        S.Layout storage l = S.layout();
        _onlyK(l);
        if (!l.armed) revert Errors.NotArmed();
        P.Asset storage a = P.layout().assets[token];
        if (!a.configured) revert Errors.InvalidParams();
        PolicyMath.requireProof(proof);
        euint64 c = FHE.fromExternal(cap, proof);
        euint64 nl = FHE.min(a.l, c);
        euint64 nlmin = FHE.min(a.lmin, nl);
        euint64 ntau = FHE.min(a.tau, nl);
        FHE.allowThis(nl);
        FHE.allowThis(nlmin);
        FHE.allowThis(ntau);
        a.l = nl;
        a.lmin = nlmin;
        a.tau = ntau;
        _cleanAA();
        emit PrivateLimitsTightened(token);
    }

    // ─────────────────────────────── K + PIN: opening ───────────────────────────────

    /// @notice A PIN-gated transfer of an encrypted amount. After the PIN it waits max(bigTransfer, 72 h), then executeOp.
    function openPrivateTransfer(address token, address to, externalEuint64 amount, bytes calldata proof) external viaAccount nonReentrant returns (uint256 opId) {
        S.Layout storage l = S.layout();
        _onlyK(l);
        if (!l.armed) revert Errors.NotArmed();
        if (to == address(0) || to == address(this)) revert Errors.InvalidParams();
        if (!P.layout().assets[token].configured) revert Errors.InvalidParams();
        PolicyMath.requireProof(proof);
        euint64 amt = FHE.fromExternal(amount, proof);
        FHE.allowThis(amt);
        // the encrypted amount (h0) and the recipient (data) belong to the op content: the PIN challenge binds them
        opId = OpenLib.openWithHandles(S.A_PRIVATE_TRANSFER, token, abi.encode(to), euint64.unwrap(amt), bytes32(0), bytes32(0));
        _cleanAA();
    }

    /// @notice A PIN-gated balance view; a correct PIN runs it inside finalizeGuess.
    function openPrivateView(address token) external viaAccount returns (uint256) {
        return _openPlain(S.A_PRIVATE_VIEW, token);
    }

    /// @notice A PIN-gated reset of a private token's tripwire (the counter restarts and tau is drawn again).
    function openPrivateReset(address token) external viaAccount returns (uint256) {
        return _openPlain(S.A_PRIVATE_RESET, token);
    }

    /// @notice Sets (use = true) or clears the duress PIN and sets `token`'s hidden amount, after the PIN and the settings
    ///         delay. Without a duress PIN the slot takes FHE randomness, as at setup, so both cases look the same; the
    ///         client then sends a hidden amount of 0, since K alone never moves the hidden amount either.
    function openSetDuress(address token, externalEuint64 candidate, externalEbool use, externalEuint64 hidden, bytes calldata proof)
        external
        viaAccount
        nonReentrant
        returns (uint256 opId)
    {
        S.Layout storage l = S.layout();
        _onlyK(l);
        if (!l.armed) revert Errors.NotArmed();
        if (!P.layout().assets[token].configured) revert Errors.InvalidParams();
        PolicyMath.requireProof(proof);
        euint64 slot = FHE.select(FHE.fromExternal(use, proof), FHE.fromExternal(candidate, proof), FHE.randEuint64());
        euint64 h = FHE.min(FHE.fromExternal(hidden, proof), P.MAX_LIMIT);
        FHE.allowThis(slot);
        FHE.allowThis(h);
        opId = OpenLib.openWithHandles(S.A_PRIVATE_SET_DURESS, token, "", euint64.unwrap(slot), euint64.unwrap(h), bytes32(0));
        _cleanAA();
    }

    // ─────────────────────────────── hooks (EncryptedAccountP only) ───────────────────────────────

    /// @notice Phase 2 of a guess on a private op (and on a PIN change of a private-mode account). Mirrors
    ///         OpsLib.afterGuess; additionally keeps the encrypted duress flag of this verification with the op (op.h2):
    ///         the per-track guess record that holds it now is reused by the next guess.
    function privateAfterGuess(uint256 opId, bool ok, uint8 track) external viaAccount {
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        if (op.status != S.Status.Guessing) {
            emit IAccountEvents.GuessFinalized(opId, track, ok, 0); // the op was cancelled meanwhile
            return;
        }
        bool alive = PolicyMath.live(l, op);
        if (!ok || !alive) {
            if (alive) {
                op.status = S.Status.NeedsPin;
            } else {
                op.status = S.Status.Cancelled; // an escape (K54) or an owner change came in between
                emit IAccountEvents.OpCancelled(opId);
            }
            emit IAccountEvents.GuessFinalized(opId, track, ok, 0);
            return;
        }
        uint64 readyAt = uint64(block.timestamp) + _delay(l, op.sub);
        op.status = S.Status.Delayed;
        op.readyAt = readyAt;
        op.h2 = l.trackGuesses[track].duressFlagH;
        emit IAccountEvents.GuessFinalized(opId, track, true, readyAt);
        if (readyAt == block.timestamp) {
            op.status = S.Status.Executed;
            _run(l, opId, op);
        }
    }

    /// @notice Runs a verified private op after its delay (EncryptedAccountP.executeOp, permissionless). Same checks as
    ///         OpsLib.executeOp.
    function privateExecuteOp(uint256 opId) external viaAccount {
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        if (PolicyMath.status(l, op) != S.Status.Delayed) revert Errors.BadStatus(); // escape-cancelled → Cancelled
        if (block.timestamp < op.readyAt) revert Errors.NotReady();
        if (op.paused) revert Errors.OpPaused();
        if (op.ownerEpoch != l.ownerEpoch) revert Errors.StaleOp();
        op.status = S.Status.Executed;
        _run(l, opId, op);
    }

    // ─────────────────────────────── escape ───────────────────────────────

    /// @notice After the escape delay, moves the whole encrypted balance of each of the account's private tokens to the
    ///         escape address (the snapshot taken when the escape started). Permissionless, no PIN, no input, no
    ///         decryption: the balance handle the account already holds is transferred as it is.
    /// @dev Depends on the FHE host contracts on-chain (executor, ACL): if they are paused or broken this reverts, and the
    ///      tokens wait in the account (still under the escape's rules: no K-only path, no PIN op, no generic call). The
    ///      ETH / ERC-20 escape is a separate call (executeEscape) with no FHE in it.
    function executeEscapeConfidential(address[] calldata tokens) external viaAccount nonReentrant {
        S.Layout storage l = S.layout();
        if (l.escapeReadyAt == 0) revert Errors.NoEscape();
        if (block.timestamp < l.escapeReadyAt) revert Errors.NotReady();
        address to = l.escapeTo;
        P.Layout storage pl = P.layout();
        for (uint256 i = 0; i < tokens.length; i++) {
            if (!pl.assets[tokens[i]].configured) continue; // only the account's own private tokens
            euint64 bal = IERC7984(tokens[i]).confidentialBalanceOf(address(this));
            if (!FHE.isInitialized(bal)) continue;
            euint64 moved = IERC7984(tokens[i]).confidentialTransfer(to, bal);
            emit PrivateEscape(tokens[i], to, euint64.unwrap(moved));
        }
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice Handles of a token's private state (handles are not secrets; reading a value needs an ACL permission).
    function privateState(address token)
        external
        view
        viaAccount
        returns (bool configured, uint64 epoch, bytes32 spent, bytes32 lmin, bytes32 lmax, bytes32 tau, bytes32 hidden, bytes32 lastView)
    {
        P.Asset storage a = P.layout().assets[token];
        return (
            a.configured,
            a.epoch,
            euint64.unwrap(a.spent),
            euint64.unwrap(a.lmin),
            euint64.unwrap(a.l),
            euint64.unwrap(a.tau),
            euint64.unwrap(a.hidden),
            euint64.unwrap(a.lastView)
        );
    }

    /// @notice The delay a verified private op of this kind waits (public: the client shows it before the PIN).
    function privateDelay(uint8 sub) external view viaAccount returns (uint64) {
        return _delay(S.layout(), sub);
    }

    // ─────────────────────────────── internals ───────────────────────────────

    function _openPlain(uint8 sub, address token) private returns (uint256) {
        S.Layout storage l = S.layout();
        _onlyK(l);
        if (!l.armed) revert Errors.NotArmed();
        if (!P.layout().assets[token].configured) revert Errors.InvalidParams();
        return OpenLib.openWithHandles(sub, token, "", bytes32(0), bytes32(0), bytes32(0));
    }

    function _delay(S.Layout storage l, uint8 sub) private view returns (uint64) {
        if (sub == S.A_PRIVATE_VIEW || sub == S.A_PRIVATE_RESET) return 0;
        if (sub == S.A_PRIVATE_TRANSFER) {
            uint32 b = l.delays.bigTransfer;
            return b > P.MIN_BIG_DELAY ? b : P.MIN_BIG_DELAY;
        }
        return l.delays.settings; // A_PIN_CHANGE, A_PRIVATE_SET_DURESS
    }

    /// @dev Every branch runs the same operations under the real and the duress PIN; `dz` only picks encrypted values.
    function _run(S.Layout storage l, uint256 opId, S.Op storage op) private {
        uint8 sub = op.sub;
        ebool dz = ebool.wrap(op.h2);
        bytes32 result;
        if (sub == S.A_PIN_CHANGE) {
            // under the duress PIN the change lands on the duress fingerprint; the real PIN stays (§17.6)
            euint64 nf = euint64.wrap(op.h0);
            euint64 pin = FHE.select(dz, l.pinH, nf);
            euint64 dur = FHE.select(dz, nf, l.duressH);
            FHE.allowThis(pin);
            FHE.allowThis(dur);
            l.pinH = pin;
            l.duressH = dur;
            emit IAccountEvents.FingerprintChanged();
        } else {
            P.Asset storage a = P.layout().assets[op.target];
            if (sub == S.A_PRIVATE_SET_DURESS) {
                // Under the duress PIN this changes nothing (the coercer cannot move the duress PIN or the hidden amount).
                // Limit: a coercer who sets a "new duress PIN" this way and then tries it sees it fail (private-mode.md §8).
                euint64 dur = FHE.select(dz, l.duressH, euint64.wrap(op.h0));
                euint64 h = FHE.select(dz, a.hidden, euint64.wrap(op.h1));
                FHE.allowThis(dur);
                FHE.allowThis(h);
                l.duressH = dur;
                a.hidden = h;
            } else if (sub == S.A_PRIVATE_RESET) {
                // The same under both PINs: a reset that did nothing under the duress PIN would show in the next K-only
                // send. K alone never reaches the hidden amount, so a coercer gains nothing from a fresh wire.
                euint64 zero = FHE.asEuint64(0);
                euint64 tau = _drawTau(a);
                FHE.allowThis(zero);
                FHE.allowThis(tau);
                a.spent = zero;
                a.tau = tau;
            } else {
                // The duress PIN works on the balance above the hidden amount as if that were the whole balance.
                euint64 bal = IERC7984(op.target).confidentialBalanceOf(address(this));
                euint64 hc = FHE.min(a.hidden, bal);
                euint64 shown = FHE.sub(bal, hc);
                if (sub == S.A_PRIVATE_VIEW) {
                    // A duress view clamps the hidden amount to the balance, and it stays so: what the coercer saw is the
                    // anchor, and a deposit he makes afterwards shows in full, as on a real balance. (A transfer needs no
                    // clamp: it moves at most `shown`, so the balance stays at or above the hidden amount.)
                    euint64 h = FHE.select(dz, hc, a.hidden);
                    FHE.allowThis(h);
                    a.hidden = h;
                    // a fresh handle in both modes: it never equals the token's stored balance handle
                    euint64 v = FHE.select(dz, shown, bal);
                    FHE.allowThis(v);
                    FHE.allow(v, l.owner);
                    a.lastView = v;
                    result = euint64.unwrap(v);
                } else {
                    // A_PRIVATE_TRANSFER: under duress up to `shown` moves and more moves zero, exactly like an ERC-7984
                    // transfer above the balance (a partial move would give duress away)
                    euint64 amt = euint64.wrap(op.h0);
                    euint64 send = FHE.select(dz, FHE.select(FHE.le(amt, shown), amt, FHE.asEuint64(0)), amt);
                    FHE.allowTransient(send, op.target);
                    euint64 moved = IERC7984(op.target).confidentialTransfer(abi.decode(op.data, (address)), send);
                    result = euint64.unwrap(moved);
                }
            }
        }
        emit PrivateOpExecuted(opId, sub, result);
        emit IAccountEvents.OpExecuted(opId);
    }

    /// @dev τ v2 (K47, as PolicyLib): D = min(L − L_min, 2^48 − 1), τ = L_min + ((D · r) >> 16), r uniform in [0, 2^16).
    function _drawTau(P.Asset storage a) private returns (euint64) {
        euint64 d = FHE.min(FHE.sub(a.l, a.lmin), uint64(type(uint48).max));
        euint64 r = FHE.asEuint64(FHE.randEuint16());
        return FHE.add(a.lmin, FHE.shr(FHE.mul(d, r), uint8(16)));
    }

    /// @dev Day buckets like PolicyMath.rollEpoch; a fired tripwire survives the restart.
    function _roll(P.Asset storage a) private {
        uint64 e = PolicyMath.currentEpoch();
        if (a.epoch != e) {
            a.epoch = e;
            euint64 r = FHE.select(FHE.eq(a.spent, P.TRIPPED), FHE.asEuint64(P.TRIPPED), FHE.asEuint64(0));
            FHE.allowThis(r);
            a.spent = r;
        }
    }

    function _onlyK(S.Layout storage l) private view {
        if (msg.sender != l.owner && msg.sender != entryPoint) revert Errors.NotAuthorized();
    }

    /// @dev Zama's AA guidance (as the account's aaHygiene): transient ACL storage outlives a UserOp inside a bundle.
    function _cleanAA() private {
        if (msg.sender == entryPoint) FHE.cleanTransientStorage();
    }

    /// @dev The active known recipients (same rule as PolicyLib._activeSet).
    function _recipients(S.Layout storage l) private view returns (eaddress[] memory arr) {
        uint256 n = S.N_RECIPIENTS;
        arr = new eaddress[](n);
        uint256 cnt;
        for (uint256 i = 0; i < n; i++) {
            uint64 at = l.knownRActiveAt[i];
            if (at != 0 && at <= block.timestamp) arr[cnt++] = l.knownR[i];
        }
        assembly {
            mstore(arr, cnt)
        }
    }
}
