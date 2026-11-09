// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AccountStorage as S} from "./AccountStorage.sol";
import {EncryptedAccount} from "./EncryptedAccount.sol";

/// @title EncryptedAccountFactory — counterfactual ERC-1167 clones of an immutable implementation.
/// @dev The address is known before deployment, which the Argon2id salt needs (Section 13.1). The CREATE2 salt
///      commits to *every* init parameter, so a front-runner can only ever deploy exactly the user's config.
///      Encrypted setup (PIN, limits, known sets) happens after creation, in execution — never inside the
///      ERC-4337 validation phase (ERC-7562 forbids the FHE contracts' storage there).
contract EncryptedAccountFactory {
    address public immutable implementation;

    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    /// @notice Example defaults of the v0.3 document (Section 11.3 / 11.6). Values are *examples*, tuned after Phase 0.
    function defaultDelays() public pure returns (S.Delays memory d) {
        d.pinTransfer = 1 hours;
        d.bigTransfer = 48 hours;
        d.genericCall = 48 hours;
        d.settings = 24 hours;
        d.loosen = 72 hours;
        d.knownAdd = 24 hours;
        d.recovery = 7 days;
        d.recoveryNoDevice = 30 days;
        d.pinReset = 30 days;
        d.escape = 30 days;
        d.escapeChange = 30 days;
    }

    function predictAddress(
        address owner,
        address escapeAddress,
        address guardian,
        S.Delays memory d,
        bytes32 userSalt
    ) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(owner, escapeAddress, guardian, d, userSalt));
    }

    /// @param escapeSig EIP-712 consent of `escapeAddress` for the predicted account (K55). It is not part of the
    ///        CREATE2 salt (it signs the address, so it cannot be); the salt already fixes the escape address.
    function createAccount(
        address owner,
        address escapeAddress,
        address guardian,
        bytes32 userSalt,
        bytes calldata escapeSig
    ) external returns (EncryptedAccount) {
        return createAccountWithDelays(owner, escapeAddress, guardian, defaultDelays(), userSalt, escapeSig);
    }

    function createAccountWithDelays(
        address owner,
        address escapeAddress,
        address guardian,
        S.Delays memory d,
        bytes32 userSalt,
        bytes calldata escapeSig
    ) public returns (EncryptedAccount account) {
        bytes32 salt = _salt(owner, escapeAddress, guardian, d, userSalt);
        address predicted = Clones.predictDeterministicAddress(implementation, salt);
        if (predicted.code.length > 0) return EncryptedAccount(payable(predicted)); // idempotent (ERC-4337 initCode)
        account = EncryptedAccount(payable(Clones.cloneDeterministic(implementation, salt)));
        account.initialize(owner, escapeAddress, guardian, d, escapeSig);
        emit AccountCreated(address(account), owner, userSalt);
    }

    function _salt(address owner, address escapeAddress, address guardian, S.Delays memory d, bytes32 userSalt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, escapeAddress, guardian, d, userSalt));
    }
}
