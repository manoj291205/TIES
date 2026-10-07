// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ISettlementEngine
/// @notice The part of the settlement engine that the policy book reads.
interface ISettlementEngine {
    /// @notice Largest bucket whose policies are settled as paying for the event; -1 if none.
    /// @param eventId The insured event.
    /// @return The pay cursor.
    function payCursor(uint256 eventId) external view returns (int256);
}
