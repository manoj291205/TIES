// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaselineBase} from "./BaselineBase.sol";

/// @title BaselineSingle
/// @notice One oracle decides: the first report is the truth.
contract BaselineSingle is BaselineBase {
    constructor(address admin) BaselineBase(admin) {}

    function _decide(
        uint256 eventId,
        uint256 count
    ) internal view override returns (bool, uint256) {
        return (count >= 1, _values[eventId][0]);
    }
}
