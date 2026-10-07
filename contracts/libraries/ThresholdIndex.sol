// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ThresholdIndex
/// @notice Fenwick (binary indexed) tree over threshold buckets. Each bucket holds the collateral
///         locked by policies whose threshold equals that bucket boundary. Supports point additions
///         and prefix/range sums in O(log size).
/// @dev Buckets are 0-based externally; the tree is 1-based internally. Range arguments are signed so
///      callers can pass cursors such as -1 ("nothing settled") or window edges that fall outside
///      the axis; they are clamped to [0, size - 1].
library ThresholdIndex {
    struct Tree {
        mapping(uint256 => uint256) nodes;
    }

    /// @notice The bucket is outside the tree.
    error BucketOutOfRange(uint256 bucket, uint256 size);

    /// @notice Add `amount` to `bucket`.
    /// @param t The tree.
    /// @param size Number of buckets in the tree.
    /// @param bucket Bucket to increase.
    /// @param amount Amount to add.
    function add(Tree storage t, uint256 size, uint256 bucket, uint256 amount) internal {
        if (bucket >= size) revert BucketOutOfRange(bucket, size);
        for (uint256 i = bucket + 1; i <= size; i += i & (~i + 1)) {
            t.nodes[i] += amount;
        }
    }

    /// @notice Sum of buckets 0..bucket (inclusive). A negative bucket gives 0; a bucket past the end
    ///         is clamped to the last bucket.
    /// @param t The tree.
    /// @param size Number of buckets in the tree.
    /// @param bucket Last bucket included.
    /// @return sum The inclusive prefix sum.
    function prefix(
        Tree storage t,
        uint256 size,
        int256 bucket
    ) internal view returns (uint256 sum) {
        if (bucket < 0) return 0;
        uint256 last = uint256(bucket);
        if (last >= size) last = size - 1;
        for (uint256 i = last + 1; i > 0; i -= i & (~i + 1)) {
            sum += t.nodes[i];
        }
    }

    /// @notice Sum of buckets from..to (both inclusive), clamped to the tree. Empty ranges give 0.
    /// @param t The tree.
    /// @param size Number of buckets in the tree.
    /// @param from First bucket included.
    /// @param to Last bucket included.
    /// @return The range sum.
    function range(
        Tree storage t,
        uint256 size,
        int256 from,
        int256 to
    ) internal view returns (uint256) {
        if (from < 0) from = 0;
        if (to >= int256(size)) to = int256(size) - 1;
        if (from > to) return 0;
        return prefix(t, size, to) - prefix(t, size, from - 1);
    }
}
