// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ThresholdIndex} from "../libraries/ThresholdIndex.sol";

/// @dev Test-only wrapper exposing the Fenwick tree library.
contract ThresholdIndexHarness {
    using ThresholdIndex for ThresholdIndex.Tree;

    ThresholdIndex.Tree private _tree;
    uint256 public immutable size;

    constructor(uint256 size_) {
        size = size_;
    }

    function add(uint256 bucket, uint256 amount) external {
        _tree.add(size, bucket, amount);
    }

    function prefix(int256 bucket) external view returns (uint256) {
        return _tree.prefix(size, bucket);
    }

    function range(int256 from, int256 to) external view returns (uint256) {
        return _tree.range(size, from, to);
    }
}
