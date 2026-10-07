// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaselineBase} from "./BaselineBase.sol";

/// @title BaselineAvg2
/// @notice The rule of the earlier prototype: two reports are required and their simple average
///         is the verified value, applied to every policy one by one.
contract BaselineAvg2 is BaselineBase {
    constructor(address admin) BaselineBase(admin) {}

    function _decide(
        uint256 eventId,
        uint256 count
    ) internal view override returns (bool, uint256) {
        if (count < 2) return (false, 0);
        return (true, (_values[eventId][0] + _values[eventId][1]) / 2);
    }
}
