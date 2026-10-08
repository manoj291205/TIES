// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PolicyBook} from "./PolicyBook.sol";
import {TIESRegistry} from "./TIESRegistry.sol";

/// @title EscalationPlanner
/// @notice Decides whether, and with whom, to open another oracle round (spec 3.7 step 2). It
///         sizes the recruitment from the margin to the most valuable held bucket, then ranks
///         oracles on sources that are not yet represented by the gain in effective independent
///         sources times their reputation.
/// @dev Read-only. The settlement engine calls it and acts on the answer, so a wrong answer could
///      only cost an extra round, never move money.
contract EscalationPlanner {
    uint256 private constant WAD = 1e18;
    /// @notice Held buckets scanned for the most valuable one; beyond this the bucket nearest the
    ///         consensus value is used.
    uint256 public constant MAX_BUCKET_SCAN = 64;

    TIESRegistry public immutable registry;
    PolicyBook public immutable book;

    /// @notice State of the event after a finalized round.
    struct PlanInput {
        uint256 eventId;
        uint8 category;
        uint32 version;
        uint8 round; // round just finalized (1-based)
        bool hasConsensus; // false if no report carried any weight
        bool insufficient; // N_eff below the minimum
        int256 payCursor;
        int256 noPayCursor;
        uint256 consensus; // V, milli-units
        uint256 sigma; // sigma_V, milli-units
        uint256 nEff; // WAD
        uint32[] sourceIds; // distinct sources already represented
        uint256[] sourceWeights; // total report weight per represented source (WAD)
        address[] reporters; // oracles that reported, or committed and withheld, on this event
    }

    /// @param registry_ The registry.
    /// @param book_ The policy book.
    constructor(TIESRegistry registry_, PolicyBook book_) {
        registry = registry_;
        book = book_;
    }

    /// @notice Plan the next round.
    /// @param in_ The event state after the round.
    /// @return escalate False when no useful round is possible (futility or no candidates).
    /// @return k Number of oracles the margin and sufficiency rules ask for (at most k_round).
    /// @return selected The oracles to recruit (at most `k`).
    function plan(
        PlanInput memory in_
    ) external view returns (bool escalate, uint256 k, address[] memory selected) {
        TIESRegistry.CategoryParams memory p = registry.getParams(in_.category, in_.version);

        uint256 kInsufficient = in_.insufficient
            ? _ceilWad(p.nMin - Math.min(in_.nEff, p.nMin))
            : 0;
        (uint256 kMargin, bool futile) = _margin(in_, p);
        if (futile) {
            // An unreachable margin ends escalation only once the evidence is sufficient. With
            // insufficient evidence the consensus itself is not yet trusted, so sources are still
            // recruited to reach N_min.
            if (!in_.insufficient) return (false, 0, new address[](0));
            kMargin = 0;
        }

        k = Math.min(p.kRound, Math.max(kInsufficient, kMargin));
        if (k == 0) k = 1;

        selected = _rank(in_, p, k);
        escalate = selected.length > 0;
    }

    // ------------------------------------------------------------------- sizing

    function _margin(
        PlanInput memory in_,
        TIESRegistry.CategoryParams memory p
    ) private view returns (uint256 kMargin, bool futile) {
        if (!in_.hasConsensus) return (0, false);
        (bool any, uint256 bucket) = _valuableBucket(in_, p);
        if (!any) return (0, false);

        uint256 theta = bucket * p.bucketWidth;
        uint256 needed = in_.consensus > theta ? in_.consensus - theta : theta - in_.consensus;
        if (needed == 0) return (0, true);

        uint256 half = Math.mulDiv(p.zByRound[in_.round], in_.sigma, WAD);
        uint256 nNeeded = Math.mulDiv(in_.nEff, half * half, needed * needed);
        if (nNeeded > in_.nEff) kMargin = _ceilWad(nNeeded - in_.nEff);
        futile = kMargin > uint256(p.kRound) * (uint256(p.kMax) - in_.round);
    }

    /// @dev The held bucket with the most collateral. When the held range is wider than
    ///      MAX_BUCKET_SCAN buckets, only the MAX_BUCKET_SCAN buckets centred on the bucket nearest
    ///      the consensus are scanned. A window without collateral imposes no margin.
    function _valuableBucket(
        PlanInput memory in_,
        TIESRegistry.CategoryParams memory p
    ) private view returns (bool any, uint256 bucket) {
        if (in_.noPayCursor - in_.payCursor < 2) return (false, 0);
        uint256 from = uint256(in_.payCursor + 1);
        uint256 to = uint256(in_.noPayCursor - 1);

        uint256 start = from;
        uint256 end = to;
        uint256 nearest = Math.min(
            Math.max((in_.consensus + p.bucketWidth / 2) / p.bucketWidth, from),
            to
        );
        if (to - from + 1 > MAX_BUCKET_SCAN) {
            start = nearest > from + MAX_BUCKET_SCAN / 2 ? nearest - MAX_BUCKET_SCAN / 2 : from;
            if (start + MAX_BUCKET_SCAN - 1 > to) start = to - (MAX_BUCKET_SCAN - 1);
            end = start + MAX_BUCKET_SCAN - 1;
        }

        uint256[] memory amounts = book.bucketsInRange(in_.eventId, start, end);
        uint256 best;
        for (uint256 i = 0; i < amounts.length; i++) {
            if (amounts[i] > best) {
                best = amounts[i];
                bucket = start + i;
            }
        }
        return (best > 0, bucket);
    }

    // ------------------------------------------------------------------ ranking

    struct Pool {
        uint256 sumWeight; // sum of represented source weights (WAD)
        uint256 den; // sum_st W_s W_t rho_st (WAD squared)
        uint256 nNow; // current effective sources (WAD)
    }

    function _rank(
        PlanInput memory in_,
        TIESRegistry.CategoryParams memory p,
        uint256 k
    ) private view returns (address[] memory selected) {
        (address[] memory oracles, uint32[] memory sources, uint256[] memory reps) = registry
            .activeOracleInfo(in_.category);

        Pool memory pool = _pool(in_, p);
        uint256 n = oracles.length;
        uint256[] memory score = new uint256[](n);
        bytes32[] memory tie = new bytes32[](n);
        bool[] memory eligible = new bool[](n);
        for (uint256 j = 0; j < n; j++) {
            if (reps[j] < p.rMin) continue;
            if (_contains(in_.reporters, oracles[j])) continue;
            if (_containsSource(in_.sourceIds, sources[j])) continue;
            eligible[j] = true;
            score[j] = _score(in_, p, pool, sources[j], reps[j]);
            tie[j] = keccak256(abi.encode(block.prevrandao, in_.eventId, oracles[j]));
        }
        return _topK(oracles, eligible, score, tie, k);
    }

    function _pool(
        PlanInput memory in_,
        TIESRegistry.CategoryParams memory p
    ) private view returns (Pool memory pool) {
        uint256 m = in_.sourceIds.length;
        if (m == 0) return pool;
        uint256[] memory rho = registry.dependenceMatrix(in_.sourceIds, p.rho0);
        for (uint256 s = 0; s < m; s++) {
            pool.sumWeight += in_.sourceWeights[s];
            for (uint256 t = 0; t < m; t++) {
                pool.den += Math.mulDiv(
                    in_.sourceWeights[s] * in_.sourceWeights[t],
                    rho[s * m + t],
                    WAD
                );
            }
        }
        if (pool.den > 0) pool.nNow = Math.mulDiv(pool.sumWeight * pool.sumWeight, WAD, pool.den);
    }

    /// @dev (N_eff with the candidate added at its prior weight, minus N_eff now) times its reputation.
    function _score(
        PlanInput memory in_,
        TIESRegistry.CategoryParams memory p,
        Pool memory pool,
        uint32 source,
        uint256 rep
    ) private view returns (uint256) {
        uint256 cross;
        uint256 m = in_.sourceIds.length;
        if (m > 0) {
            uint256[] memory rho = registry.dependenceVector(source, in_.sourceIds, p.rho0);
            for (uint256 s = 0; s < m; s++) {
                cross += Math.mulDiv(rep * in_.sourceWeights[s], rho[s], WAD);
            }
        }
        uint256 denNext = pool.den + 2 * cross + rep * rep;
        uint256 sumNext = pool.sumWeight + rep;
        uint256 nNext = Math.mulDiv(sumNext * sumNext, WAD, denNext);
        uint256 gain = nNext > pool.nNow ? nNext - pool.nNow : 0;
        return Math.mulDiv(gain, rep, WAD);
    }

    /// @dev Highest score first; equal scores are ordered by the tie-break hash (lower first).
    function _topK(
        address[] memory oracles,
        bool[] memory eligible,
        uint256[] memory score,
        bytes32[] memory tie,
        uint256 k
    ) private pure returns (address[] memory selected) {
        uint256 n = oracles.length;
        uint256 count;
        for (uint256 j = 0; j < n; j++) if (eligible[j]) count++;
        if (count > k) count = k;
        selected = new address[](count);
        for (uint256 pick = 0; pick < count; pick++) {
            uint256 best = type(uint256).max;
            for (uint256 j = 0; j < n; j++) {
                if (!eligible[j]) continue;
                if (
                    best == type(uint256).max ||
                    score[j] > score[best] ||
                    (score[j] == score[best] && tie[j] < tie[best])
                ) best = j;
            }
            selected[pick] = oracles[best];
            eligible[best] = false;
        }
    }

    // ------------------------------------------------------------------- helpers

    function _ceilWad(uint256 x) private pure returns (uint256) {
        return (x + WAD - 1) / WAD;
    }

    function _contains(address[] memory list, address who) private pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) if (list[i] == who) return true;
        return false;
    }

    function _containsSource(uint32[] memory list, uint32 id) private pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) if (list[i] == id) return true;
        return false;
    }
}
