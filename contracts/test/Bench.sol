// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, eaddress} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice Micro-benchmarks for E19 (known-set size) and E7 (tripwire draw distribution). Test only.
contract Bench is ZamaEthereumConfig {
    eaddress[] internal list;
    euint64 public lmin;
    euint64 public lmax;
    euint64[] internal taus;
    ebool public lastBit;

    function fillList(uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            eaddress a = FHE.asEaddress(address(uint160(i + 1)));
            FHE.allowThis(a);
            list.push(a);
        }
    }

    function _first(uint256 n) internal view returns (eaddress[] memory arr) {
        arr = new eaddress[](n);
        for (uint256 i = 0; i < n; i++) arr[i] = list[i];
    }

    function isInBench(address who, uint256 n) external {
        ebool r = FHE.isIn(FHE.asEaddress(who), _first(n));
        FHE.allowThis(r);
        lastBit = r;
    }

    /// Doc 12.9 formula: N eq + (N-1) or, linear chain.
    function eqOrBench(address who, uint256 n) external {
        eaddress w = FHE.asEaddress(who);
        ebool r = FHE.eq(w, list[0]);
        for (uint256 i = 1; i < n; i++) r = FHE.or(r, FHE.eq(w, list[i]));
        FHE.allowThis(r);
        lastBit = r;
    }

    /// Same, but with a balanced OR tree (lower sequential depth).
    function eqOrTreeBench(address who, uint256 n) external {
        eaddress w = FHE.asEaddress(who);
        ebool[] memory lvl = new ebool[](n);
        for (uint256 i = 0; i < n; i++) lvl[i] = FHE.eq(w, list[i]);
        uint256 m = n;
        while (m > 1) {
            uint256 k = (m + 1) / 2;
            for (uint256 i = 0; i < m / 2; i++) lvl[i] = FHE.or(lvl[2 * i], lvl[2 * i + 1]);
            if (m % 2 == 1) lvl[k - 1] = lvl[m - 1];
            m = k;
        }
        FHE.allowThis(lvl[0]);
        lastBit = lvl[0];
    }

    function setBounds(uint64 a, uint64 b) external {
        lmin = FHE.asEuint64(a);
        lmax = FHE.asEuint64(b);
        FHE.allowThis(lmin);
        FHE.allowThis(lmax);
    }

    /// Identical to PolicyLib._drawTau.
    function drawTau(uint256 k) external {
        for (uint256 i = 0; i < k; i++) {
            euint64 width = FHE.sub(lmax, lmin);
            euint64 r = FHE.asEuint64(FHE.randEuint16());
            euint64 tau = FHE.add(lmin, FHE.mul(FHE.shr(width, uint8(16)), r));
            FHE.allowThis(tau);
            taus.push(tau);
        }
    }

    function tauAt(uint256 i) external view returns (euint64) {
        return taus[i];
    }

    function tausLength() external view returns (uint256) {
        return taus.length;
    }
}
