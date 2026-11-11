// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EncryptedWill, IEncryptedAccountView} from "./EncryptedWill.sol";

/// @title WillFactoryBase — deterministic ERC-1167 clones of {EncryptedWill}, within the factory's periods
/// @dev Each factory deploys its own implementation, which accepts only this factory as its initializer, so a will
///      with periods outside the factory's bounds cannot exist under this factory's implementation. The CREATE2 salt
///      commits to every parameter: a front-runner can only deploy exactly the owner's will. Anyone may create a will;
///      only its account can give it heirs.
abstract contract WillFactoryBase {
    address public immutable implementation;

    event WillCreated(address indexed will, address indexed account, uint32 inactivity, uint32 grace, uint32 claimWindow);

    error PeriodOutOfBounds();

    constructor() {
        implementation = address(new EncryptedWill(address(this)));
    }

    /// @return minInactivity, maxInactivity, minGrace, maxGrace, minClaimWindow, maxClaimWindow (seconds)
    function bounds() public view virtual returns (uint32, uint32, uint32, uint32, uint32, uint32);

    /// @dev Extra checks against the account (the production factory compares with its PIN pulse).
    function _checkAccount(address account, uint32 inactivity) internal view virtual {}

    function predictWill(address account, uint32 inactivity, uint32 grace, uint32 claimWindow) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(account, inactivity, grace, claimWindow));
    }

    function createWill(address account, uint32 inactivity, uint32 grace, uint32 claimWindow) external returns (EncryptedWill will) {
        (uint32 minI, uint32 maxI, uint32 minG, uint32 maxG, uint32 minW, uint32 maxW) = bounds();
        if (inactivity < minI || inactivity > maxI || grace < minG || grace > maxG || claimWindow < minW || claimWindow > maxW) {
            revert PeriodOutOfBounds();
        }
        _checkAccount(account, inactivity);
        bytes32 salt = _salt(account, inactivity, grace, claimWindow);
        address predicted = Clones.predictDeterministicAddress(implementation, salt);
        if (predicted.code.length > 0) return EncryptedWill(predicted);
        will = EncryptedWill(Clones.cloneDeterministic(implementation, salt));
        will.initialize(account, inactivity, grace, claimWindow);
        emit WillCreated(address(will), account, inactivity, grace, claimWindow);
    }

    function _salt(address account, uint32 inactivity, uint32 grace, uint32 claimWindow) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, inactivity, grace, claimWindow));
    }
}

/// @title EncryptedWillFactory — production periods
/// @notice inactivity 90 days to 5 years (default 180 days) and never shorter than the account's PIN pulse; grace 30
///         days to 1 year (default 30 days); claim window at least 1 year (default 2 years, at most 10 years).
contract EncryptedWillFactory is WillFactoryBase {
    uint32 public constant DEFAULT_INACTIVITY = 180 days;
    uint32 public constant DEFAULT_GRACE = 30 days;
    uint32 public constant DEFAULT_CLAIM_WINDOW = 730 days;

    error InactivityBelowPulse();

    function bounds() public pure override returns (uint32, uint32, uint32, uint32, uint32, uint32) {
        return (90 days, 5 * 365 days, 30 days, 365 days, 365 days, 10 * 365 days);
    }

    function _checkAccount(address account, uint32 inactivity) internal view override {
        (, , , , uint32 pulse, , , ) = IEncryptedAccountView(account).status();
        if (pulse != 0 && inactivity < pulse) revert InactivityBelowPulse();
    }
}

/// @title EncryptedWillDemoFactory — DEMO periods, testnets only
/// @notice Every period from 5 minutes, so a visitor sees a whole inheritance in minutes. Its constructor refuses any
///         chain but Sepolia and a local chain, so it cannot exist on mainnet.
contract EncryptedWillDemoFactory is WillFactoryBase {
    error NotTestnet();

    constructor() {
        if (!isTestnet(block.chainid)) revert NotTestnet();
    }

    function isTestnet(uint256 chainId) public pure returns (bool) {
        return chainId == 11155111 || chainId == 31337;
    }

    function bounds() public pure override returns (uint32, uint32, uint32, uint32, uint32, uint32) {
        return (5 minutes, 5 * 365 days, 5 minutes, 365 days, 5 minutes, 10 * 365 days);
    }
}
