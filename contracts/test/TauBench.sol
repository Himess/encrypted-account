// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice E7-v2 (F0.10, K47): tripwire draws of v1 and v2 side by side. Test only — bounds are trivially encrypted
///         and every draw is made publicly decryptable so that the distribution can be checked on a live network.
contract TauBench is ZamaEthereumConfig {
    euint64 public lmin;
    euint64 public lmax;
    euint64[] internal taus;

    event Drawn(uint8 version, uint256 index, bytes32 handle);

    /// @dev Same normalisation as PolicyLib._applyLimits: L = max(L, L_min).
    function setBounds(uint64 a, uint64 b) external {
        lmin = FHE.asEuint64(a);
        lmax = FHE.max(FHE.asEuint64(b), lmin);
        FHE.allowThis(lmin);
        FHE.allowThis(lmax);
    }

    /// @notice Round 1 formula: τ = L_min + ((L − L_min) >> 16) · r.
    function drawV1(uint256 k) external {
        for (uint256 i = 0; i < k; i++) {
            euint64 width = FHE.sub(lmax, lmin);
            euint64 r = FHE.asEuint64(FHE.randEuint16());
            _push(1, FHE.add(lmin, FHE.mul(FHE.shr(width, uint8(16)), r)));
        }
    }

    /// @notice Identical to PolicyLib._drawTau (v2): D = min(L − L_min, 2^48 − 1), τ = L_min + ((D · r) >> 16).
    function drawV2(uint256 k) external {
        for (uint256 i = 0; i < k; i++) {
            euint64 d = FHE.min(FHE.sub(lmax, lmin), uint64(type(uint48).max));
            euint64 r = FHE.asEuint64(FHE.randEuint16());
            _push(2, FHE.add(lmin, FHE.shr(FHE.mul(d, r), uint8(16))));
        }
    }

    function _push(uint8 v, euint64 tau) internal {
        FHE.allowThis(tau);
        FHE.makePubliclyDecryptable(tau);
        emit Drawn(v, taus.length, euint64.unwrap(tau));
        taus.push(tau);
    }

    function tauAt(uint256 i) external view returns (euint64) {
        return taus[i];
    }

    function tausLength() external view returns (uint256) {
        return taus.length;
    }
}
