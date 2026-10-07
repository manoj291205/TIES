// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SettlementEngine} from "../core/SettlementEngine.sol";

/// @dev Test helper: a challenger whose receive function burns all the gas it is given while
///      `greedy` is set, as a contract trying to block a dispute resolution would.
contract GreedyChallenger {
    SettlementEngine public immutable engine;
    bool public greedy = true;
    uint256 private _sink;

    constructor(SettlementEngine engine_) {
        engine = engine_;
    }

    function setGreedy(bool greedy_) external {
        greedy = greedy_;
    }

    function challenge(uint256 eventId) external payable {
        engine.challenge{value: msg.value}(eventId);
    }

    function withdrawBond() external {
        engine.withdrawBond();
    }

    // The loop is the point of this mock: it burns whatever gas the sender forwards.
    // solhint-disable-next-line no-complex-fallback
    receive() external payable {
        if (!greedy) return;
        while (true) _sink++;
    }
}
