// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISettlementEngine} from "../interfaces/ISettlementEngine.sol";
import {Vault} from "../core/Vault.sol";

/// @dev Test-only stand-in for the settlement engine: sets cursors and moves vault collateral.
contract MockEngine is ISettlementEngine {
    Vault public immutable vault;
    mapping(uint256 => int256) private _payCursor;

    constructor(Vault vault_) {
        vault = vault_;
        // Default cursor for unknown events is "nothing settled".
    }

    function payCursor(uint256 eventId) external view returns (int256) {
        int256 c = _payCursor[eventId];
        return c == 0 ? int256(-1) : c - 1;
    }

    /// @dev Stores cursor + 1 so that the zero value means -1.
    function setPayCursor(uint256 eventId, int256 cursor) external {
        _payCursor[eventId] = cursor + 1;
    }

    function settlePay(uint256 amount) external {
        vault.moveLockedToClaimable(amount);
    }

    function settleNoPay(uint256 amount) external {
        vault.unlock(amount);
    }
}
