// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {AccountStorage as S} from "../account/AccountStorage.sol";
import {Disclose} from "../account/Disclose.sol";

/// @notice Test only: drives Disclose on the account's storage layout, to show that it refuses the PIN fingerprints and
///         handles of the wrong type, and lets the intended values through.
contract DiscloseHarness {
    constructor() {
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());
    }

    function setPins(uint64 a, uint64 b) external {
        S.Layout storage l = S.layout();
        euint64 p = FHE.asEuint64(a);
        euint64 d = FHE.asEuint64(b);
        FHE.allowThis(p);
        FHE.allowThis(d);
        l.pinH = p;
        l.duressH = d;
        l.owner = msg.sender;
        l.guardian = msg.sender;
    }

    function ownerPin() external {
        Disclose.ownerU64(S.layout(), S.layout().pinH);
    }

    function guardianDuress() external {
        Disclose.guardianU64(S.layout(), S.layout().duressH);
    }

    function tokenPin(address token) external {
        Disclose.tokenTransient(S.layout(), S.layout().pinH, token);
    }

    function publicPinAsBool() external {
        Disclose.publicBool(ebool.wrap(euint64.unwrap(S.layout().pinH)));
    }

    function guardianPinAsBool() external {
        Disclose.guardianBool(S.layout(), ebool.wrap(euint64.unwrap(S.layout().pinH)));
    }

    function ownerFresh(uint64 x) external {
        euint64 v = FHE.asEuint64(x);
        FHE.allowThis(v);
        Disclose.ownerU64(S.layout(), v);
    }

    function publicFresh(bool x) external {
        ebool v = FHE.asEbool(x);
        FHE.allowThis(v);
        Disclose.publicBool(v);
    }
}
