// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title BaselineBase
/// @notice Shared plumbing of the comparison contracts used in the experiments. Each baseline has
///         its own pool, binds policies through the same interface as TIES (event, threshold
///         bucket, payout, premium) and settles by looping over every policy of the event.
/// @dev Oracle reports are per event, not per policy. A concrete baseline only decides when the
///      reports are enough and which value they give. There is no evidence interval, no source
///      attestation and no escalation here; that is the point of the comparison.
abstract contract BaselineBase is AccessControl {
    /// @notice Most reports one event keeps.
    uint256 public constant MAX_REPORTS = 8;
    /// @notice Smallest premium, as a share of the payout (basis points).
    uint256 public constant MIN_PREMIUM_BPS = 200;

    struct Policy {
        address holder;
        uint32 bucket;
        bool settled;
        uint256 payout;
    }

    struct EventInfo {
        bool exists;
        bool settled;
        uint64 cutoff;
        uint256 reportCount;
    }

    /// @notice ETH not reserved for policies.
    uint256 public free;
    /// @notice ETH reserved as collateral for open policies.
    uint256 public locked;
    /// @notice Settled payouts waiting to be claimed.
    mapping(address => uint256) public claimable;
    mapping(uint256 => EventInfo) public eventInfo;
    mapping(uint256 => Policy[]) internal _policies;
    mapping(uint256 => uint256[8]) internal _values;
    mapping(uint256 => mapping(address => bool)) internal _reported;
    /// @notice Source id an oracle key reads (set by the admin; informational for these baselines).
    mapping(address => uint32) public sourceOf;
    mapping(address => bool) public isOracle;

    event PolicyBound(
        uint256 indexed eventId,
        uint256 policyIndex,
        address holder,
        uint32 bucket,
        uint256 payout
    );
    event ReportSubmitted(uint256 indexed eventId, address indexed oracle, uint256 value);
    event Settled(uint256 indexed eventId, uint256 value, uint256 policies);
    event Claimed(address indexed holder, uint256 amount);

    error UnknownEvent(uint256 eventId);
    error CutoffPassed();
    error NotOracle();
    error AlreadyReported();
    error TooManyReports();
    error PremiumTooLow(uint256 sent, uint256 required);
    error NotEnoughLiquidity();
    error NotReady();
    error AlreadySettled();
    error NothingToClaim();
    error TransferFailed();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Add liquidity to this baseline's own pool.
    function fund() external payable {
        free += msg.value;
    }

    /// @notice Create an event that accepts policies until `cutoff`.
    /// @param eventId Caller-chosen id.
    /// @param cutoff Binding closes at this timestamp.
    function createEvent(uint256 eventId, uint64 cutoff) external onlyRole(DEFAULT_ADMIN_ROLE) {
        eventInfo[eventId] = EventInfo(true, false, cutoff, 0);
    }

    /// @notice Allow an oracle key to report, reading `sourceId`.
    /// @param oracle Oracle key.
    /// @param sourceId Source the key reads.
    function setOracle(address oracle, uint32 sourceId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isOracle[oracle] = true;
        sourceOf[oracle] = sourceId;
    }

    /// @notice Bind a policy that pays `payout` if the value is at least `bucket` units.
    /// @param eventId The event.
    /// @param bucket Threshold in whole units.
    /// @param payout Payout in wei.
    function bind(uint256 eventId, uint32 bucket, uint256 payout) external payable {
        EventInfo storage e = eventInfo[eventId];
        if (!e.exists) revert UnknownEvent(eventId);
        if (block.timestamp >= e.cutoff) revert CutoffPassed();
        uint256 required = (payout * MIN_PREMIUM_BPS) / 10_000;
        if (msg.value < required) revert PremiumTooLow(msg.value, required);
        if (free < payout) revert NotEnoughLiquidity();
        free = free + msg.value - payout;
        locked += payout;
        _policies[eventId].push(Policy(msg.sender, bucket, false, payout));
        emit PolicyBound(eventId, _policies[eventId].length - 1, msg.sender, bucket, payout);
    }

    /// @notice Submit an oracle report (milli-units) for an event.
    /// @param eventId The event.
    /// @param value Reported value in milli-units.
    function report(uint256 eventId, uint256 value) external {
        if (!isOracle[msg.sender]) revert NotOracle();
        EventInfo storage e = eventInfo[eventId];
        if (!e.exists) revert UnknownEvent(eventId);
        if (_reported[eventId][msg.sender]) revert AlreadyReported();
        if (e.reportCount >= MAX_REPORTS) revert TooManyReports();
        _reported[eventId][msg.sender] = true;
        _values[eventId][e.reportCount] = value;
        e.reportCount += 1;
        emit ReportSubmitted(eventId, msg.sender, value);
    }

    /// @notice Settle every policy of the event, one by one, once the reports are enough.
    /// @param eventId The event.
    function settleAll(uint256 eventId) external {
        EventInfo storage e = eventInfo[eventId];
        if (!e.exists) revert UnknownEvent(eventId);
        if (e.settled) revert AlreadySettled();
        (bool ready, uint256 value) = _decide(eventId, e.reportCount);
        if (!ready) revert NotReady();
        e.settled = true;
        Policy[] storage list = _policies[eventId];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            Policy storage p = list[i];
            p.settled = true;
            locked -= p.payout;
            if (value >= uint256(p.bucket) * 1000) {
                claimable[p.holder] += p.payout;
            } else {
                free += p.payout;
            }
        }
        emit Settled(eventId, value, n);
    }

    /// @notice Withdraw settled payouts.
    function claim() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        emit Claimed(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Number of policies on an event.
    /// @param eventId The event.
    /// @return Policy count.
    function policyCount(uint256 eventId) external view returns (uint256) {
        return _policies[eventId].length;
    }

    /// @notice A policy.
    /// @param eventId The event.
    /// @param index Policy index within the event.
    /// @return The policy.
    function policyAt(uint256 eventId, uint256 index) external view returns (Policy memory) {
        return _policies[eventId][index];
    }

    /// @notice Reports of an event so far.
    /// @param eventId The event.
    /// @return values The reported values, in submission order.
    function reportsOf(uint256 eventId) external view returns (uint256[] memory values) {
        uint256 n = eventInfo[eventId].reportCount;
        values = new uint256[](n);
        for (uint256 i = 0; i < n; i++) values[i] = _values[eventId][i];
    }

    /// @dev Whether the reports so far are enough, and the value they give.
    function _decide(
        uint256 eventId,
        uint256 count
    ) internal view virtual returns (bool ready, uint256 value);

    /// @dev Median of the first `count` reports (the mean of the two middle ones for an even count).
    function _median(uint256 eventId, uint256 count) internal view returns (uint256) {
        uint256[8] memory v = _values[eventId];
        for (uint256 i = 1; i < count; i++) {
            uint256 key = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1] > key) {
                v[j] = v[j - 1];
                j--;
            }
            v[j] = key;
        }
        if (count % 2 == 1) return v[count / 2];
        return (v[count / 2 - 1] + v[count / 2]) / 2;
    }
}
