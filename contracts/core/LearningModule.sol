// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PolicyBook} from "./PolicyBook.sol";
import {TIESRegistry} from "./TIESRegistry.sol";

/// @title LearningModule
/// @notice Updates per-category oracle reputation and learned source dependence once an event is
///         final (spec 3.9). Only the settlement engine may call it.
/// @dev Needs ENGINE_ROLE on the registry. Reputation is a beta-style (alpha, beta) pair that decays
///      by gamma per event; an oracle is penalised in proportion to the collateral its report
///      would have settled differently from the final value.
contract LearningModule is AccessControl {
    uint256 private constant WAD = 1e18;

    TIESRegistry public immutable registry;
    PolicyBook public immutable book;
    /// @notice The only caller allowed to trigger learning.
    address public engine;

    /// @notice What the engine knows about a finished event.
    struct LearnInput {
        uint256 eventId;
        uint8 category;
        uint32 version;
        uint256 finalValue; // V*, milli-units
        uint256 total; // collateral locked on the event
        address[] oracles; // oracle of each revealed report
        uint32[] sources; // source of each revealed report
        uint256[] values; // value of each revealed report
        address[] silent; // committee members that never revealed (unique)
    }

    error NotEngine();
    error EngineAlreadySet();

    /// @param registry_ The registry.
    /// @param book_ The policy book.
    /// @param admin Account receiving the admin role.
    constructor(TIESRegistry registry_, PolicyBook book_, address admin) {
        registry = registry_;
        book = book_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Set the settlement engine (once).
    /// @param engine_ The engine address.
    function setEngine(address engine_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (engine != address(0)) revert EngineAlreadySet();
        engine = engine_;
    }

    /// @notice Apply the learning update for a finished event.
    /// @param in_ The event outcome and its reports.
    function learn(LearnInput memory in_) external {
        if (msg.sender != engine) revert NotEngine();
        TIESRegistry.CategoryParams memory p = registry.getParams(in_.category, in_.version);
        _updateReputation(in_, p);
        _updateDependence(in_, p);
    }

    // ----------------------------------------------------------------- reputation

    function _updateReputation(
        LearnInput memory in_,
        TIESRegistry.CategoryParams memory p
    ) private {
        for (uint256 i = 0; i < in_.oracles.length; i++) {
            uint256 x = in_.values[i];
            uint256 gap = x > in_.finalValue ? x - in_.finalValue : in_.finalValue - x;
            bool accurate = Math.mulDiv(gap, WAD, p.s) <= p.eps;
            uint256 flip = _flipShare(in_, x, p.bucketWidth);

            (uint256 alpha, uint256 beta) = registry.reputation(in_.oracles[i], in_.category);
            alpha = Math.mulDiv(p.gamma, alpha, WAD) + (accurate ? WAD - flip : 0);
            beta = Math.mulDiv(p.gamma, beta, WAD) + flip + (accurate ? 0 : WAD);
            registry.setReputation(in_.oracles[i], in_.category, alpha, beta);
        }
        for (uint256 i = 0; i < in_.silent.length; i++) {
            (uint256 alpha, uint256 beta) = registry.reputation(in_.silent[i], in_.category);
            registry.setReputation(
                in_.silent[i],
                in_.category,
                alpha,
                Math.mulDiv(p.gamma, beta, WAD) + WAD
            );
        }
    }

    /// @dev Share (WAD) of the event's collateral whose pay / no-pay decision would differ if the
    ///      event were judged at `x` instead of the final value: thresholds in (min, max].
    function _flipShare(
        LearnInput memory in_,
        uint256 x,
        uint256 width
    ) private view returns (uint256) {
        if (in_.total == 0) return 0;
        uint256 lo = Math.min(x, in_.finalValue);
        uint256 hi = Math.max(x, in_.finalValue);
        int256 from = int256(lo / width) + 1;
        int256 to = int256(hi / width);
        if (from > to) return 0;
        return Math.mulDiv(book.rangeCollateral(in_.eventId, from, to), WAD, in_.total);
    }

    // ----------------------------------------------------------------- dependence

    function _updateDependence(
        LearnInput memory in_,
        TIESRegistry.CategoryParams memory p
    ) private {
        (uint32[] memory ids, int256[] memory meanError) = _meanErrors(in_, p);
        for (uint256 a = 0; a < ids.length; a++) {
            for (uint256 b = a + 1; b < ids.length; b++) {
                bool together = _abs(meanError[a]) > p.eps &&
                    _abs(meanError[b]) > p.eps &&
                    (meanError[a] > 0) == (meanError[b] > 0);
                uint256 old = registry.dependence(ids[a], ids[b], p.rho0);
                uint256 next = Math.mulDiv(WAD - p.mu, old, WAD) + (together ? p.mu : 0);
                next = Math.min(Math.max(next, p.rho0), WAD);
                registry.setDependence(ids[a], ids[b], next);
            }
        }
    }

    /// @dev Mean signed error (x - V*) / s per distinct source, in order of first appearance.
    function _meanErrors(
        LearnInput memory in_,
        TIESRegistry.CategoryParams memory p
    ) private pure returns (uint32[] memory ids, int256[] memory mean) {
        uint256 n = in_.sources.length;
        uint32[] memory seen = new uint32[](n);
        int256[] memory sum = new int256[](n);
        uint256[] memory count = new uint256[](n);
        uint256 distinct;
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = distinct;
            for (uint256 j = 0; j < distinct; j++) {
                if (seen[j] == in_.sources[i]) {
                    slot = j;
                    break;
                }
            }
            if (slot == distinct) {
                seen[distinct] = in_.sources[i];
                distinct++;
            }
            sum[slot] +=
                ((int256(in_.values[i]) - int256(in_.finalValue)) * int256(WAD)) /
                int256(p.s);
            count[slot] += 1;
        }
        ids = new uint32[](distinct);
        mean = new int256[](distinct);
        for (uint256 j = 0; j < distinct; j++) {
            ids[j] = seen[j];
            mean[j] = sum[j] / int256(count[j]);
        }
    }

    function _abs(int256 v) private pure returns (uint256) {
        return v >= 0 ? uint256(v) : uint256(-v);
    }
}
