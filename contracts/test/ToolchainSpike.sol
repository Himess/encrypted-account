// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool, eaddress, externalEuint64, externalEaddress} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice Toolchain check in the mock environment: isIn, bounded randomness,
///         public decryption + checkSignatures, and empty-proof behaviour.
contract ToolchainSpike is ZamaEthereumConfig {
    euint64 public secret;
    eaddress[] internal list;
    ebool public lastBit;
    euint64 public lastRand;

    function setSecret(externalEuint64 h, bytes calldata proof) external {
        secret = FHE.fromExternal(h, proof);
        FHE.allowThis(secret);
    }

    function addToList(externalEaddress h, bytes calldata proof) external {
        eaddress a = FHE.fromExternal(h, proof);
        FHE.allowThis(a);
        list.push(a);
    }

    function padList(uint256 n) external {
        for (uint256 i = 0; i < n; i++) {
            eaddress z = FHE.asEaddress(address(0));
            FHE.allowThis(z);
            list.push(z);
        }
    }

    function checkIsIn(address who) external {
        ebool r = FHE.isIn(FHE.asEaddress(who), list);
        FHE.allowThis(r);
        FHE.makePubliclyDecryptable(r);
        lastBit = r;
    }

    function checkEqOr(address who) external {
        eaddress w = FHE.asEaddress(who);
        ebool r = FHE.eq(w, list[0]);
        for (uint256 i = 1; i < list.length; i++) {
            r = FHE.or(r, FHE.eq(w, list[i]));
        }
        FHE.allowThis(r);
        FHE.makePubliclyDecryptable(r);
        lastBit = r;
    }

    function guessWithChallenge(externalEuint64 h, bytes calldata proof, uint64 c) external {
        euint64 g = FHE.fromExternal(h, proof);
        ebool r = FHE.eq(FHE.add(secret, c), g);
        FHE.allowThis(r);
        FHE.makePubliclyDecryptable(r);
        lastBit = r;
    }

    function drawRand() external {
        lastRand = FHE.randEuint64(uint64(1) << 16);
        FHE.allowThis(lastRand);
    }

    bool public verifiedValue;

    function verify(bytes calldata cleartexts, bytes calldata proof) external {
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = ebool.unwrap(lastBit);
        FHE.checkSignatures(hs, cleartexts, proof);
        verifiedValue = abi.decode(cleartexts, (bool));
    }

    /// fromExternal with an empty proof: accepted if the caller is allowed on the handle (0.11+ behaviour).
    function emptyProofProbe(bytes32 handle) external returns (bytes32) {
        euint64 v = FHE.fromExternal(externalEuint64.wrap(handle), "");
        return euint64.unwrap(v);
    }
}
