// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, eaddress, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "../vendor/openzeppelin-confidential/interfaces/IERC7984.sol";
import {AccountStorage as S, Errors} from "../account/AccountStorage.sol";
import {PolicyMath} from "../account/PolicyMath.sol";
import {OpenLib} from "../account/OpenLib.sol";
import {PrivateStorage as P} from "./PrivateStorage.sol";

/// @title PrivateModule — SPIKE: private mode for ERC-7984 tokens (design doc v0.4, Phase 2: F2.1–F2.3)
/// @notice Runs only through DELEGATECALL from EncryptedAccountP's fallback, so it has the account's storage, ACL
///         identity and msg.sender. Three paths:
///  - privateTransfer: K alone, ONE transaction, no decryption. The hidden limit, the tripwire and the known list are
///    applied with `select`: a transfer that breaks a rule moves an encrypted zero (silent zero).
///  - openPrivateView + PIN: the balance becomes visible to K as a fresh encrypted snapshot (K alone never sees it).
///  - openPrivateTransfer + PIN: a delayed transfer of an encrypted amount.
///  Under the duress PIN both PIN paths use the decoy: the view shows min(balance, decoy left) and a transfer behaves as if
///  the balance were the decoy left (more than that moves zero, like any ERC-7984 transfer above the balance). Every
///  path runs the same FHE operations, writes the same slots and emits the same events in both modes.
/// @dev Spike code: no audit, Sepolia only. Not wired into the A/B variants.
contract PrivateModule {
    /// @notice The EntryPoint of the account implementation that uses this module (K may also act through it).
    address public immutable entryPoint;
    address private immutable self;

    event PrivateAssetSet(address indexed token);
    /// @param moved handle of what the token really moved (an encrypted zero when a rule failed)
    event PrivateTransfer(address indexed token, address indexed to, bytes32 moved);
    /// @param result the snapshot handle (view) or the moved handle (transfer)
    event PrivateOpExecuted(uint256 indexed opId, uint8 sub, bytes32 result);

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

    /// @notice Setup (before arming): enables a confidential token for the private paths and stores the decoy cap.
    ///         The token's limits must be set first with the account's setupAsset(token, 1, L_min, L, L_big).
    /// @param decoyCap client-encrypted in every account (a random value when no duress PIN is set), so the dataflow
    ///        does not show whether a duress PIN exists.
    function privateSetupAsset(address token, externalEuint64 decoyCap, bytes calldata proof) external viaAccount {
        S.Layout storage l = S.layout();
        if (l.armed) revert Errors.AlreadyArmed();
        _onlyK(l);
        if (!l.assets[token].configured) revert Errors.InvalidParams();
        PolicyMath.requireProof(proof);
        euint64 d = FHE.fromExternal(decoyCap, proof);
        FHE.allowThis(d);
        P.Asset storage a = P.layout().assets[token];
        a.configured = true;
        a.epoch = PolicyMath.currentEpoch();
        a.decoyCap = d;
        // encrypted zeros now, so the first transfer writes the same kind of slots as every later one
        euint64 z = FHE.asEuint64(0);
        FHE.allowThis(z);
        a.spent = z;
        a.decoySpent = z;
        _cleanAA();
        emit PrivateAssetSet(token);
    }

    // ─────────────────────────────── K alone: one transaction ───────────────────────────────

    /// @notice K-only private transfer, synchronous (design doc 14, "ERC-7984 varlıklar"):
    ///   room = tau − spent (max-guarded);  fits = amount <= room;  known = isIn(to, recipients)
    ///   pass = known AND NOT tripped AND fits;  moved = token.transfer(to, select(pass, amount, 0))
    ///   spent += moved;  tripped = tripped OR NOT fits (sticky)
    /// Nothing is decrypted. The pass bit and the moved amount are allowed to the guardian (watchtower) only: K never
    /// learns whether a transfer passed, so a key thief cannot probe the hidden limit.
    function privateTransfer(address token, address to, externalEuint64 amount, bytes calldata proof) external viaAccount returns (bytes32) {
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

        S.AssetEnc storage e = l.assetEnc[token];
        // tightenLimits can push tau below spent: max keeps room at 0 instead of wrapping around
        euint64 room = FHE.sub(FHE.max(e.tau, a.spent), a.spent);
        ebool fits = FHE.le(amt, room);
        ebool known = FHE.isIn(FHE.asEaddress(to), _recipients(l));
        ebool pass = FHE.and(FHE.and(known, FHE.not(e.tripped)), fits);
        euint64 send = FHE.select(pass, amt, FHE.asEuint64(0));
        FHE.allowTransient(send, token);
        euint64 moved = IERC7984(token).confidentialTransfer(to, send);

        euint64 spent = FHE.add(a.spent, moved);
        FHE.allowThis(spent);
        a.spent = spent;
        ebool tripped = FHE.or(e.tripped, FHE.not(fits));
        FHE.allowThis(tripped);
        FHE.allowThis(pass);
        if (l.guardian != address(0)) {
            FHE.allow(tripped, l.guardian); // silent alarm, as in PolicyLib
            FHE.allow(pass, l.guardian);
            FHE.allow(moved, l.guardian);
        }
        e.tripped = tripped;
        a.lastPass = pass;
        a.lastMoved = moved;
        _cleanAA();
        emit PrivateTransfer(token, to, euint64.unwrap(moved));
        return euint64.unwrap(moved);
    }

    // ─────────────────────────────── K + PIN ───────────────────────────────

    /// @notice Opens a PIN-gated transfer of an encrypted amount; after the PIN and the pinTransfer delay, executeOp runs it.
    function openPrivateTransfer(address token, address to, externalEuint64 amount, bytes calldata proof) external viaAccount returns (uint256 opId) {
        S.Layout storage l = S.layout();
        _onlyK(l);
        if (!l.armed) revert Errors.NotArmed();
        if (to == address(0) || to == address(this)) revert Errors.InvalidParams();
        if (!P.layout().assets[token].configured) revert Errors.InvalidParams();
        PolicyMath.requireProof(proof);
        euint64 amt = FHE.fromExternal(amount, proof);
        FHE.allowThis(amt);
        // the encrypted amount (h0) and the recipient (data) belong to the op content, so the PIN challenge binds them
        opId = OpenLib.openWithHandles(S.A_PRIVATE_TRANSFER, token, abi.encode(to), euint64.unwrap(amt), bytes32(0), bytes32(0));
        _cleanAA();
    }

    /// @notice Opens a PIN-gated balance view; a correct PIN runs it inside finalizeGuess (no delay).
    function openPrivateView(address token) external viaAccount returns (uint256 opId) {
        S.Layout storage l = S.layout();
        _onlyK(l);
        if (!l.armed) revert Errors.NotArmed();
        if (!P.layout().assets[token].configured) revert Errors.InvalidParams();
        opId = OpenLib.openWithHandles(S.A_PRIVATE_VIEW, token, "", bytes32(0), bytes32(0), bytes32(0));
    }

    /// @notice Runs a PIN-verified private op. Only the account itself calls it (OpsLib._execute), after the PIN and the
    ///         delay; OpsLib.afterGuess has stored the encrypted duress flag of that verification in op.h2 (§17.6).
    function privateExecute(uint256 opId) external viaAccount {
        if (msg.sender != address(this)) revert Errors.NotAuthorized();
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        address token = op.target;
        P.Asset storage a = P.layout().assets[token];
        ebool dz = ebool.wrap(op.h2);
        // decoy left = cap − spent under duress (max-guarded)
        euint64 left = FHE.sub(FHE.max(a.decoyCap, a.decoySpent), a.decoySpent);
        euint64 result;
        if (op.sub == S.A_PRIVATE_VIEW) {
            euint64 bal = IERC7984(token).confidentialBalanceOf(address(this));
            // a fresh handle in both modes: it never equals the token's stored balance handle
            result = FHE.select(dz, FHE.min(bal, left), bal);
            FHE.allowThis(result);
            FHE.allow(result, l.owner);
            a.lastView = result;
        } else {
            euint64 amt = euint64.wrap(op.h0);
            // under duress the decoy acts as the balance: up to `left` moves, more moves zero (like any 7984 transfer)
            euint64 send = FHE.select(dz, FHE.select(FHE.le(amt, left), amt, FHE.asEuint64(0)), amt);
            FHE.allowTransient(send, token);
            result = IERC7984(token).confidentialTransfer(abi.decode(op.data, (address)), send);
            euint64 ds = FHE.add(a.decoySpent, FHE.select(dz, result, FHE.asEuint64(0)));
            FHE.allowThis(ds);
            a.decoySpent = ds;
        }
        emit PrivateOpExecuted(opId, op.sub, euint64.unwrap(result));
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice Handles of a token's private state (handles are not secrets; values need an ACL permission).
    function privateState(address token)
        external
        view
        viaAccount
        returns (bool configured, uint64 epoch, bytes32 spent, bytes32 decoyCap, bytes32 decoySpent, bytes32 lastView, bytes32 lastPass, bytes32 lastMoved)
    {
        P.Asset storage a = P.layout().assets[token];
        return (
            a.configured,
            a.epoch,
            euint64.unwrap(a.spent),
            euint64.unwrap(a.decoyCap),
            euint64.unwrap(a.decoySpent),
            euint64.unwrap(a.lastView),
            ebool.unwrap(a.lastPass),
            euint64.unwrap(a.lastMoved)
        );
    }

    // ─────────────────────────────── internals ───────────────────────────────

    function _onlyK(S.Layout storage l) private view {
        if (msg.sender != l.owner && msg.sender != entryPoint) revert Errors.NotAuthorized();
    }

    /// @dev Zama's AA guidance (as the account's aaHygiene): transient ACL storage outlives a UserOp inside a bundle.
    function _cleanAA() private {
        if (msg.sender == entryPoint) FHE.cleanTransientStorage();
    }

    /// @dev Day buckets like PolicyMath.rollEpoch; the restart is public anyway (block time).
    function _roll(P.Asset storage a) private {
        uint64 now_ = PolicyMath.currentEpoch();
        if (a.epoch != now_) {
            a.epoch = now_;
            euint64 z = FHE.asEuint64(0);
            FHE.allowThis(z);
            a.spent = z;
        }
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
