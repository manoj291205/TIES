// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SettlementEngine} from "../core/SettlementEngine.sol";
import {PolicyBook} from "../core/PolicyBook.sol";
import {TIESRegistry} from "../core/TIESRegistry.sol";
import {Vault} from "../core/Vault.sol";
import {IOriginVerifier} from "../verifiers/IOriginVerifier.sol";

/// @dev Test-only engine that lets a test open a further round directly.
contract SettlementEngineHarness is SettlementEngine {
    constructor(
        Vault vault_,
        PolicyBook book_,
        TIESRegistry registry_,
        IOriginVerifier verifier_,
        address admin
    ) SettlementEngine(vault_, book_, registry_, verifier_, admin) {}

    function forceNextRound(uint256 eventId, address[] memory committee) external {
        EventState storage st = _state[eventId];
        _beginRound(eventId, st, st.round + 1, committee, 120, 120);
    }
}
