// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Aggregation} from "../libraries/Aggregation.sol";

/// @dev Test-only wrapper exposing the aggregation library.
contract AggregationHarness {
    function run(
        uint256[] memory x,
        uint256[] memory rep,
        uint256[] memory rho,
        uint256 s,
        uint256 sigmaFloor,
        uint256 delta,
        uint256 dCut
    ) external pure returns (Aggregation.Result memory) {
        return Aggregation.run(Aggregation.Input(x, rep, rho, s, sigmaFloor, delta, dCut));
    }

    function weightedMedian(
        uint256[] memory x,
        uint256[] memory rep
    ) external pure returns (uint256) {
        return Aggregation.weightedMedian(x, rep);
    }
}
