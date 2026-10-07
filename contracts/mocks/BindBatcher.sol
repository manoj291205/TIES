// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyBook} from "../core/PolicyBook.sol";

/// @dev Test-only helper that binds many policies in one transaction.
contract BindBatcher {
    function bindMany(
        PolicyBook book,
        uint256 eventId,
        uint256[] calldata buckets,
        uint256 payout
    ) external payable {
        for (uint256 i = 0; i < buckets.length; i++) {
            book.bind{value: book.quote(eventId, buckets[i], payout)}(eventId, buckets[i], payout);
        }
    }

    receive() external payable {}
}
