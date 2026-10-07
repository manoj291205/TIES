// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaselineBase} from "./BaselineBase.sol";

/// @title BaselineMedian3
/// @notice Two of three: once two oracles have reported, the median of the reports so far (at
///         most three) is the value. Counts oracle keys, not independent sources.
contract BaselineMedian3 is BaselineBase {
    constructor(address admin) BaselineBase(admin) {}

    function _decide(
        uint256 eventId,
        uint256 count
    ) internal view override returns (bool, uint256) {
        if (count < 2) return (false, 0);
        return (true, _median(eventId, count > 3 ? 3 : count));
    }
}
