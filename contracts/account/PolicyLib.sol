// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, eaddress, externalEuint64, externalEaddress, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {AccountStorage as S, Errors, IAccountEvents} from "./AccountStorage.sol";
import {PolicyMath} from "./PolicyMath.sol";

/// @title PolicyLib — encrypted policy (ERC-B draft, Section 14 of the design)
/// @notice Hidden limit, random tripwire, encrypted known recipient/spender sets, anomaly evaluation.
/// @dev External library executed via DELEGATECALL in the account's context.
library PolicyLib {
    // ─────────────────────────────── limits & tripwire ───────────────────────────────

    function setupLimits(
        address asset,
        uint256 unit,
        externalEuint64 lmin,
        externalEuint64 lmax,
        externalEuint64 big,
        bytes calldata proof
    ) external {
        PolicyMath.requireProof(proof);
        _applyLimits(
            asset,
            unit,
            FHE.fromExternal(lmin, proof),
            FHE.fromExternal(lmax, proof),
            FHE.fromExternal(big, proof)
        );
    }

    /// @notice B variant (F0.11) setup: public K-only limit per epoch and the encrypted L_big of the (unchanged) PIN
    ///         path. No L_min, L or tripwire.
    function setupBig(address asset, uint256 unit, uint256 openLimit, externalEuint64 big, bytes calldata proof) external {
        PolicyMath.requireProof(proof);
        if (unit == 0 || unit > type(uint128).max) revert Errors.InvalidParams();
        S.Layout storage l = S.layout();
        S.AssetCfg storage cfg = l.assets[asset];
        cfg.configured = true;
        cfg.unit = uint128(unit);
        cfg.openLimit = openLimit;
        euint64 b = FHE.fromExternal(big, proof);
        FHE.allowThis(b);
        l.assetEnc[asset].big = b;
        emit IAccountEvents.OpenLimitSet(asset, openLimit);
    }

    function storeLimits(
        externalEuint64 lmin,
        externalEuint64 lmax,
        externalEuint64 big,
        bytes calldata proof
    ) external returns (bytes32 h0, bytes32 h1, bytes32 h2) {
        PolicyMath.requireProof(proof);
        euint64 a = FHE.fromExternal(lmin, proof);
        euint64 b = FHE.fromExternal(lmax, proof);
        euint64 c = FHE.fromExternal(big, proof);
        FHE.allowThis(a);
        FHE.allowThis(b);
        FHE.allowThis(c);
        return (euint64.unwrap(a), euint64.unwrap(b), euint64.unwrap(c));
    }

    function applyLimits(address asset, uint256 unit, bytes32 h0, bytes32 h1, bytes32 h2) external {
        _applyLimits(asset, unit, euint64.wrap(h0), euint64.wrap(h1), euint64.wrap(h2));
    }

    function _applyLimits(address asset, uint256 unit, euint64 lmin, euint64 lmax, euint64 big) private {
        if (unit == 0 || unit > type(uint128).max) revert Errors.InvalidParams();
        S.Layout storage l = S.layout();
        S.AssetCfg storage cfg = l.assets[asset];
        cfg.configured = true;
        cfg.unit = uint128(unit);
        S.AssetEnc storage e = l.assetEnc[asset];
        euint64 hi = FHE.max(lmax, lmin); // normalise: range is never empty
        FHE.allowThis(lmin);
        FHE.allowThis(hi);
        FHE.allowThis(big);
        e.lmin = lmin;
        e.l = hi;
        e.big = big;
        _drawTau(e);
        _setTripped(l, e, FHE.asEbool(false));
        emit IAccountEvents.LimitsSet(asset);
    }

    /// @dev τ v2 (K47): D = min(L − L_min, 2^48 − 1),  τ = L_min + ((D · r) >> 16),  r uniform in [0, 2^16).
    ///      Works with *encrypted* bounds (FHE.rem only takes plaintext divisors). D · r < 2^64, so nothing
    ///      overflows; τ ∈ [L_min, L) (τ = L_min when D = 0) and τ − L_min spreads almost uniformly over [0, D) even
    ///      for narrow ranges. v1 (((L − L_min) >> 16) · r) stuck to L_min for D < 2^16 and covered only half the
    ///      range for 2^16 ≤ D < 2^17 (Y2). L ≥ L_min holds by construction (`_applyLimits` normalises with max).
    function _drawTau(S.AssetEnc storage e) private {
        euint64 d = FHE.min(FHE.sub(e.l, e.lmin), uint64(type(uint48).max));
        euint64 r = FHE.asEuint64(FHE.randEuint16());
        euint64 tau = FHE.add(e.lmin, FHE.shr(FHE.mul(d, r), uint8(16)));
        FHE.allowThis(tau);
        e.tau = tau;
    }

    function _setTripped(S.Layout storage l, S.AssetEnc storage e, ebool v) private {
        FHE.allowThis(v);
        if (l.guardian != address(0)) FHE.allow(v, l.guardian); // silent alarm: guardian user-decrypts privately
        e.tripped = v;
    }

    /// @notice K+P: clears the sticky tripwire and re-draws tau (Section 14.2).
    function resetTrip(address asset) external {
        S.Layout storage l = S.layout();
        if (!l.assets[asset].configured) revert Errors.InvalidParams();
        S.AssetEnc storage e = l.assetEnc[asset];
        _setTripped(l, e, FHE.asEbool(false));
        _drawTau(e);
    }

    /// @notice K alone, immediate: limits can only get tighter (encrypted min — no decryption needed).
    /// @dev Resolves a gap in the doc ("tightening K-only, loosening K+P"): with encrypted values the
    ///      contract cannot tell tighter from looser, but min(old, new) is tighter by construction.
    function tighten(address asset, externalEuint64 cap, externalEuint64 bigCap, bytes calldata proof) external {
        PolicyMath.requireProof(proof);
        S.Layout storage l = S.layout();
        if (!l.assets[asset].configured) revert Errors.InvalidParams();
        S.AssetEnc storage e = l.assetEnc[asset];
        euint64 c = FHE.fromExternal(cap, proof);
        euint64 bc = FHE.fromExternal(bigCap, proof);
        euint64 nl = FHE.min(e.l, c);
        euint64 nlmin = FHE.min(e.lmin, nl);
        euint64 ntau = FHE.min(e.tau, nl);
        euint64 nbig = FHE.min(e.big, bc);
        FHE.allowThis(nl);
        FHE.allowThis(nlmin);
        FHE.allowThis(ntau);
        FHE.allowThis(nbig);
        e.l = nl;
        e.lmin = nlmin;
        e.tau = ntau;
        e.big = nbig;
        emit IAccountEvents.LimitsSet(asset);
    }

    // ─────────────────────────────── evaluation (anomaly policy, open mode) ───────────────────────────────

    /// @notice Encrypted evaluation of a K-only outflow (Section 14.1, 14.7):
    ///   known = isIn(counterparty, activeSet);  fits = (spent + reserved + amount) <= tau
    ///   ok = known AND NOT tripped AND fits;    tripped' = tripped OR NOT fits   (sticky)
    /// Only `ok` becomes publicly decryptable; which condition failed is never revealed.
    /// @return evaluated false if the public sum exceeds the 64-bit range (→ PIN path, no evaluation).
    function evaluate(uint256 opId) external returns (bool evaluated) {
        S.Layout storage l = S.layout();
        S.Op storage op = l.ops[opId];
        S.AssetCfg storage cfg = l.assets[op.target];
        PolicyMath.sync(l, cfg);
        PolicyMath.rollEpoch(cfg);
        uint256 sc = PolicyMath.scaleUp(cfg.spent + cfg.reserved + op.amount, cfg.unit); // op.amount <= MAX_AMOUNT (openOutflow)
        // out of the 64-bit FHE range, or the packed pending counter would overflow → PIN path, no evaluation
        if (sc > type(uint64).max || uint256(cfg.reserved) + op.amount > type(uint112).max) return false;

        S.AssetEnc storage e = l.assetEnc[op.target];
        eaddress cp = FHE.asEaddress(op.counterparty); // counterparty is public in open mode anyway
        ebool known = FHE.isIn(cp, _activeSet(l, op.sub == S.OUT_APPROVE));
        ebool fits = FHE.ge(e.tau, uint64(sc));
        ebool ok = FHE.and(FHE.and(known, FHE.not(e.tripped)), fits);
        _setTripped(l, e, FHE.or(e.tripped, FHE.not(fits)));
        FHE.makePubliclyDecryptable(ok);

        op.h0 = ebool.unwrap(ok);
        cfg.reserved += uint112(op.amount); // N concurrent ops cannot use the threshold N times (S20)
        op.epochDay = cfg.epoch;
        op.status = S.Status.Evaluating;
        emit IAccountEvents.Evaluating(opId, op.h0);
        return true;
    }

    function _activeSet(S.Layout storage l, bool spenders) private view returns (eaddress[] memory arr) {
        uint256 n = spenders ? S.N_SPENDERS : S.N_RECIPIENTS;
        arr = new eaddress[](n);
        uint256 cnt;
        for (uint256 i = 0; i < n; i++) {
            uint64 at = spenders ? l.knownSActiveAt[i] : l.knownRActiveAt[i];
            if (at != 0 && at <= block.timestamp) {
                arr[cnt++] = spenders ? l.knownS[i] : l.knownR[i];
            }
        }
        assembly {
            mstore(arr, cnt)
        }
    }

    // ─────────────────────────────── known sets ───────────────────────────────

    /// @notice Setup only. Every slot (including empty ones) must be a *client-encrypted* value:
    ///         padding with FHE.asEaddress(address(0)) would emit TrivialEncrypt(pt = 0) events and reveal
    ///         how many slots are really used (doc 14.3 claims this count is hidden).
    function setupKnown(bool spenders, uint256 start, externalEaddress[] calldata vals, bytes calldata proof) external {
        PolicyMath.requireProof(proof);
        S.Layout storage l = S.layout();
        uint256 n = spenders ? S.N_SPENDERS : S.N_RECIPIENTS;
        if (start + vals.length > n) revert Errors.InvalidParams();
        for (uint256 i = 0; i < vals.length; i++) {
            uint256 slot = start + i;
            if ((spenders ? l.knownSActiveAt[slot] : l.knownRActiveAt[slot]) != 0) revert Errors.InvalidParams();
            eaddress a = FHE.fromExternal(vals[i], proof);
            _write(l, spenders, slot, a, 1);
        }
    }

    function storeKnown(externalEaddress val, bytes calldata proof) external returns (bytes32) {
        PolicyMath.requireProof(proof);
        eaddress a = FHE.fromExternal(val, proof);
        FHE.allowThis(a);
        return eaddress.unwrap(a);
    }

    /// @notice Execution of a K+P "add known" op (the op's own delay is the activation delay).
    function writeKnown(bool spenders, uint256 slot, bytes32 h) external {
        _write(S.layout(), spenders, slot, eaddress.wrap(h), uint64(block.timestamp));
    }

    /// @notice K alone may only *remove*: slot' = select(doRemove, 0, slot).
    /// @dev Accepting an arbitrary client ciphertext here would let a key thief write his own address
    ///      into the list (the contract cannot check an encrypted value is zero). With select the result is
    ///      either 0 or unchanged, and observers cannot tell which.
    function removeKnown(bool spenders, uint256 slot, externalEbool doRemove, bytes calldata proof) external {
        PolicyMath.requireProof(proof);
        S.Layout storage l = S.layout();
        uint256 n = spenders ? S.N_SPENDERS : S.N_RECIPIENTS;
        if (slot >= n) revert Errors.InvalidParams();
        uint64 at = spenders ? l.knownSActiveAt[slot] : l.knownRActiveAt[slot];
        if (at == 0) revert Errors.InvalidParams();
        ebool d = FHE.fromExternal(doRemove, proof);
        eaddress cur = spenders ? l.knownS[slot] : l.knownR[slot];
        _write(l, spenders, slot, FHE.select(d, FHE.asEaddress(address(0)), cur), at);
    }

    /// @notice Auto-"known" after a PIN-verified outflow (Section 14.6), without duplicates:
    ///         slot_lru' = select(isIn(who, set), slot_lru, Enc(who)). If `who` is already known nothing
    ///         changes; otherwise the least recently written slot is replaced.
    /// @dev The contract cannot know which slots are empty (all values are encrypted). Clients therefore lay
    ///      out the setup list as [encrypted zeros..., real entries...]: ties on `activeAt` resolve to the
    ///      lowest index, so empty slots are consumed before any real entry is evicted — and the number of
    ///      real entries is never revealed. Auto-added recipients are public anyway (TrivialEncrypt event).
    function autoAddKnown(bool spenders, address who) external {
        S.Layout storage l = S.layout();
        uint256 n = spenders ? S.N_SPENDERS : S.N_RECIPIENTS;
        uint256 lru;
        uint64 oldest = type(uint64).max;
        for (uint256 i = 0; i < n; i++) {
            uint64 at = spenders ? l.knownSActiveAt[i] : l.knownRActiveAt[i];
            if (at < oldest) {
                oldest = at;
                lru = i;
            }
        }
        eaddress w = FHE.asEaddress(who);
        ebool already = FHE.isIn(w, _activeSet(l, spenders));
        eaddress cur = spenders ? l.knownS[lru] : l.knownR[lru];
        _write(l, spenders, lru, FHE.select(already, cur, w), uint64(block.timestamp));
    }

    function _write(S.Layout storage l, bool spenders, uint256 slot, eaddress v, uint64 activeAt) private {
        FHE.allowThis(v);
        if (spenders) {
            l.knownS[slot] = v;
            l.knownSActiveAt[slot] = activeAt;
        } else {
            l.knownR[slot] = v;
            l.knownRActiveAt[slot] = activeAt;
        }
        emit IAccountEvents.KnownSlotWritten(spenders, slot, activeAt);
    }
}
