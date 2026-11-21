// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {EncryptedAccount} from "../account/EncryptedAccount.sol";
import {AccountStorage as S, Errors} from "../account/AccountStorage.sol";
import {PinLib} from "../account/PinLib.sol";
import {OpsLib} from "../account/OpsLib.sol";
import {OpenLib} from "../account/OpenLib.sol";
import {PrivateStorage, IPrivateHooks} from "./PrivateStorage.sol";

/// @title EncryptedAccountP — variant A with the optional private mode (ERC-7984 tokens)
/// @notice Chosen at account creation (its own factory). The A code paths are unchanged; three functions are overridden:
///  - finalizeGuess / executeOp send private ops, and the account's PIN changes, to PrivateModule (duress-aware); every
///    other op goes to OpsLib exactly as in A;
///  - openCall refuses the account's private tokens, so their balance moves only through the private paths.
///  Every call the account does not define goes to `privateModule` through DELEGATECALL (the module runs with the account's
///  storage, ACL identity and msg.sender), except the two hooks, which only this contract may reach. The module address is
///  an immutable of the implementation: clones cannot point it elsewhere.
contract EncryptedAccountP is EncryptedAccount {
    address public immutable privateModule;

    constructor(IEntryPoint ep, address feeConfig_, address module_) EncryptedAccount(ep, feeConfig_) {
        privateModule = module_;
    }

    function finalizeGuess(uint256 opId, bytes calldata cleartexts, bytes calldata decryptionProof) external override nonReentrant {
        (bool ok, bool big, uint8 track) = PinLib.finalizeGuess(opId, cleartexts, decryptionProof);
        if (_privateOp(opId)) _module(abi.encodeCall(IPrivateHooks.privateAfterGuess, (opId, ok, track)));
        else OpsLib.afterGuess(opId, ok, big, track);
    }

    function executeOp(uint256 opId) external override nonReentrant aaHygiene {
        if (_privateOp(opId)) _module(abi.encodeCall(IPrivateHooks.privateExecuteOp, (opId)));
        else OpsLib.executeOp(opId, feeConfig);
    }

    /// @notice A generic call can never reach one of the account's private tokens (no transfer, unwrap or operator around
    ///         the hidden limit and, under the duress PIN, around the hidden amount).
    function openCall(address target, uint256 value, bytes calldata data) external override onlyK whenArmed returns (uint256) {
        if (PrivateStorage.layout().assets[target].configured) revert Errors.ForbiddenTarget();
        return OpenLib.openCall(target, value, data, aclAddress, executorAddress, feeConfig);
    }

    fallback() external payable {
        bytes4 s = msg.sig;
        if (s == IPrivateHooks.privateAfterGuess.selector || s == IPrivateHooks.privateExecuteOp.selector) revert Errors.NotAuthorized();
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

    /// @dev Private ops, and PIN changes: in a private-mode account a PIN change under the duress PIN must not touch the
    ///      real PIN, so it is run by the module.
    function _privateOp(uint256 opId) private view returns (bool) {
        S.Op storage op = S.layout().ops[opId];
        if (op.kind != S.Kind.Admin) return false;
        uint8 a = op.sub;
        return a == S.A_PIN_CHANGE || (a >= S.A_PRIVATE_TRANSFER && a <= S.A_PRIVATE_SET_DURESS);
    }

    function _module(bytes memory data) private {
        (bool ok, bytes memory ret) = privateModule.delegatecall(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
