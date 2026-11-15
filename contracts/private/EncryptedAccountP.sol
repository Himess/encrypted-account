// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {EncryptedAccount} from "../account/EncryptedAccount.sol";

/// @title EncryptedAccountP — SPIKE: variant A plus the private-mode module
/// @notice Every call this account does not define goes to `privateModule` through DELEGATECALL, so the module runs with
///         the account's storage, ACL identity and msg.sender. The module address is an immutable of the implementation:
///         clones cannot point it elsewhere. The A code is unchanged; the B variant is not touched (no room left there).
contract EncryptedAccountP is EncryptedAccount {
    address public immutable privateModule;

    constructor(IEntryPoint ep, address feeConfig_, address module_) EncryptedAccount(ep, feeConfig_) {
        privateModule = module_;
    }

    fallback() external payable {
        address m = privateModule;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), m, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }
}
