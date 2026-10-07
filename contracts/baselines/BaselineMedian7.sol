// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaselineBase} from "./BaselineBase.sol";

/// @title BaselineMedian7
/// @notice A static seven-oracle quorum: the event waits for seven reports and uses their median.
///         It never asks for more or fewer, and counts keys, not independent sources.
contract BaselineMedian7 is BaselineBase {
    /// @notice Reports required before the event can settle.
    uint256 public constant QUORUM = 7;

    constructor(address admin) BaselineBase(admin) {}

    function _decide(
        uint256 eventId,
        uint256 count
    ) internal view override returns (bool, uint256) {
        if (count < QUORUM) return (false, 0);
        return (true, _median(eventId, QUORUM));
    }
}
