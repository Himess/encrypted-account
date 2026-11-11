// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EncryptedWill} from "./EncryptedWill.sol";

/// @title EncryptedWillFactory — deterministic ERC-1167 clones of {EncryptedWill}
/// @dev The CREATE2 salt commits to every parameter, so a front-runner can only deploy exactly the owner's will.
///      Anyone may create a will; only its account can give it heirs.
contract EncryptedWillFactory {
    address public immutable implementation;

    event WillCreated(address indexed will, address indexed account, uint32 inactivity, uint32 grace);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function predictWill(address account, uint32 inactivity, uint32 grace) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(account, inactivity, grace));
    }

    function createWill(address account, uint32 inactivity, uint32 grace) external returns (EncryptedWill will) {
        bytes32 salt = _salt(account, inactivity, grace);
        address predicted = Clones.predictDeterministicAddress(implementation, salt);
        if (predicted.code.length > 0) return EncryptedWill(predicted);
        will = EncryptedWill(Clones.cloneDeterministic(implementation, salt));
        will.initialize(account, inactivity, grace);
        emit WillCreated(address(will), account, inactivity, grace);
    }

    function _salt(address account, uint32 inactivity, uint32 grace) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, inactivity, grace));
    }
}
