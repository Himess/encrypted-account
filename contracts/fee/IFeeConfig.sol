// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice What an account reads from the shared fee configuration (F0.16).
interface IFeeConfig {
    /// @return fee clamp(amount * feeBps / 10_000, minFee, maxFee) in the asset's unit; 0 for an unknown asset
    /// @return version the configuration version the fee was computed with
    function quote(address asset, uint256 amount) external view returns (uint256 fee, uint64 version);

    function feeRecipient() external view returns (address);
}
