// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title TIESMath
/// @notice Fixed-point helpers (1e18 "WAD"), piecewise-linear interpolation and the attainable
///         evidence window used for capacity checks.
library TIESMath {
    uint256 internal constant WAD = 1e18;

    /// @notice The interpolation tables are empty, differ in length or are not ordered.
    error InvalidCurve();

    /// @notice a * b / WAD rounded up.
    function mulWadUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return Math.mulDiv(a, b, WAD, Math.Rounding.Ceil);
    }

    /// @notice Square root of a WAD value, returned as WAD (rounded down).
    function sqrtWad(uint256 x) internal pure returns (uint256) {
        return Math.sqrt(x * WAD);
    }

    /// @notice Piecewise-linear interpolation of a non-increasing curve. Values left of the first
    ///         point or right of the last point are clamped to the end values.
    /// @param xs Strictly increasing x coordinates.
    /// @param ys Non-increasing y coordinates (same length as xs).
    /// @param x The point to evaluate.
    /// @return y The interpolated value (decrement rounded down).
    function interpolate(
        uint256[] memory xs,
        uint256[] memory ys,
        uint256 x
    ) internal pure returns (uint256 y) {
        uint256 n = xs.length;
        if (n == 0 || n != ys.length) revert InvalidCurve();
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];
        uint256 i = 1;
        while (xs[i] < x) i++;
        uint256 x0 = xs[i - 1];
        uint256 x1 = xs[i];
        uint256 y0 = ys[i - 1];
        uint256 y1 = ys[i];
        return y0 - Math.mulDiv(y0 - y1, x - x0, x1 - x0);
    }

    /// @notice Number of buckets either side of a threshold that the best attainable evidence
    ///         interval can still resolve: w = ceil(z1 * sigmaFloor / sqrt(N_att) / bucketWidth),
    ///         with N_att = L / (1 + (L - 1) * rho0).
    /// @param sources Number of distinct active sources in the category (L).
    /// @param rho0 Prior dependence between distinct sources (WAD).
    /// @param sigmaFloor Irreducible noise (milli-units).
    /// @param z1 Round-1 z value (WAD).
    /// @param bucketWidth Bucket width (milli-units).
    /// @return w The window half-width in buckets.
    function attainableWindow(
        uint256 sources,
        uint256 rho0,
        uint256 sigmaFloor,
        uint256 z1,
        uint256 bucketWidth
    ) internal pure returns (uint256 w) {
        uint256 nAtt = Math.mulDiv(sources * WAD, WAD, WAD + (sources - 1) * rho0);
        uint256 sigmaAtt = Math.mulDiv(sigmaFloor, WAD, sqrtWad(nAtt));
        return Math.mulDiv(z1, sigmaAtt, WAD * bucketWidth, Math.Rounding.Ceil);
    }
}
