// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TIESMath} from "./TIESMath.sol";

/// @title Aggregation
/// @notice Pure implementation of the evidence aggregation (spec 3.5 steps 1-8): weighted median,
///         agreement weights, consensus value, dispersion, effective number of independent
///         sources and the resulting uncertainty.
/// @dev Report values and scales are in milli-units; weights and ratios are 1e18 fixed point.
///      Report count is bounded by the caller (at most 16).
library Aggregation {
    uint256 private constant WAD = 1e18;

    /// @notice Aggregation inputs. `rho` is a flat n x n matrix of pairwise dependence (WAD);
    ///         only off-diagonal entries are read (identical positions count as 1.0).
    struct Input {
        uint256[] x; // report values (milli-units)
        uint256[] rep; // reputation weight R_i per report (WAD)
        uint256[] rho; // n*n dependence matrix (WAD)
        uint256 s; // deviation scale (milli-units)
        uint256 sigmaFloor; // irreducible noise (milli-units)
        uint256 delta; // kernel width in s units (WAD)
        uint256 dCut; // hard outlier cut in s units (WAD)
    }

    /// @notice Aggregation outputs.
    struct Result {
        uint256 median; // weighted median m (milli-units)
        uint256 consensus; // V (milli-units)
        uint256 dispersion; // S^2 (milli-units squared)
        uint256 nEff; // effective independent sources (WAD)
        uint256 sigma; // sigma_V (milli-units)
        uint256 weightSum; // sum of w_i (WAD)
        uint256[] weights; // w_i per report (WAD)
    }

    /// @notice There are no reports to aggregate.
    error NoReports();
    /// @notice Input arrays have inconsistent lengths.
    error LengthMismatch();

    /// @notice Run spec 3.5 steps 1-8.
    /// @param in_ The reports and parameters.
    /// @return r The aggregation result; `weightSum == 0` means every report was rejected.
    function run(Input memory in_) internal pure returns (Result memory r) {
        uint256 n = in_.x.length;
        if (n == 0) revert NoReports();
        if (in_.rep.length != n || in_.rho.length != n * n) revert LengthMismatch();

        r.median = weightedMedian(in_.x, in_.rep);

        uint256[] memory w = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            w[i] = _weight(in_, i, r.median);
            r.weightSum += w[i];
        }
        r.weights = w;
        if (r.weightSum == 0) return r;

        uint256 num;
        for (uint256 i = 0; i < n; i++) num += w[i] * in_.x[i];
        r.consensus = num / r.weightSum;

        uint256 disp;
        for (uint256 i = 0; i < n; i++) {
            uint256 d = in_.x[i] > r.consensus ? in_.x[i] - r.consensus : r.consensus - in_.x[i];
            disp += w[i] * d * d;
        }
        r.dispersion = disp / r.weightSum;

        r.nEff = _effectiveSources(in_, w, r.weightSum);
        uint256 spread = Math.sqrt(r.dispersion + in_.sigmaFloor * in_.sigmaFloor);
        r.sigma = Math.mulDiv(spread, WAD, TIESMath.sqrtWad(r.nEff));
    }

    /// @notice Lower weighted median: the smallest value whose cumulative weight reaches half of
    ///         the total. Insertion sort, stable for equal values.
    /// @param x Values.
    /// @param rep Weights.
    /// @return The weighted median.
    function weightedMedian(
        uint256[] memory x,
        uint256[] memory rep
    ) internal pure returns (uint256) {
        uint256 n = x.length;
        uint256[] memory idx = new uint256[](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            idx[i] = i;
            total += rep[i];
        }
        for (uint256 i = 1; i < n; i++) {
            uint256 key = idx[i];
            uint256 j = i;
            while (j > 0 && x[idx[j - 1]] > x[key]) {
                idx[j] = idx[j - 1];
                j--;
            }
            idx[j] = key;
        }
        uint256 cum;
        for (uint256 k = 0; k < n; k++) {
            cum += rep[idx[k]];
            if (2 * cum >= total) return x[idx[k]];
        }
        return x[idx[n - 1]];
    }

    function _weight(Input memory in_, uint256 i, uint256 m) private pure returns (uint256) {
        uint256 diff = in_.x[i] > m ? in_.x[i] - m : m - in_.x[i];
        uint256 d = Math.mulDiv(diff, WAD, in_.s);
        if (d > in_.dCut) return 0;
        uint256 t = Math.mulDiv(d, WAD, in_.delta);
        uint256 agreement = Math.mulDiv(WAD, WAD, WAD + Math.mulDiv(t, t, WAD));
        return Math.mulDiv(in_.rep[i], agreement, WAD);
    }

    function _effectiveSources(
        Input memory in_,
        uint256[] memory w,
        uint256 weightSum
    ) private pure returns (uint256) {
        uint256 n = w.length;
        uint256 den;
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = 0; j < n; j++) {
                uint256 rho = i == j ? WAD : in_.rho[i * n + j];
                den += Math.mulDiv(w[i] * w[j], rho, WAD);
            }
        }
        return Math.mulDiv(weightSum * weightSum, WAD, den);
    }
}
