// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ThresholdIndex} from "../libraries/ThresholdIndex.sol";
import {TIESMath} from "../libraries/TIESMath.sol";
import {ISettlementEngine} from "../interfaces/ISettlementEngine.sol";
import {TIESRegistry} from "./TIESRegistry.sol";
import {Vault} from "./Vault.sol";

/// @title PolicyBook
/// @notice Insured events and the policies bound on them. Policies of an event are indexed by
///         threshold bucket in a Fenwick tree of locked collateral.
/// @dev A policy pays iff the true value is >= its threshold, which must be an exact bucket
///      boundary. Premiums are quoted by the contract; payouts are locked in the vault when bound.
contract PolicyBook is AccessControl, ReentrancyGuard {
    using ThresholdIndex for ThresholdIndex.Tree;

    uint256 public constant WAD = 1e18;
    /// @notice Largest number of buckets a single view call returns.
    uint256 public constant MAX_VIEW_RANGE = 1024;
    /// @notice Search radius (in buckets) of `nearestAvailableBucket`.
    uint256 public constant MAX_SEARCH_RADIUS = 64;

    struct EventData {
        bool exists;
        uint8 category;
        uint32 version; // category parameter version snapshotted at creation
        uint64 cutoff; // last moment policies can be bound (exclusive)
        uint64 observationEnd; // oracle rounds may open from here
        uint256 locked; // total collateral locked on the event
        string label;
        string observationKey;
    }

    struct Policy {
        uint256 eventId;
        address holder;
        uint32 bucket;
        bool claimed;
        uint256 payout;
        uint256 premium;
    }

    Vault public immutable vault;
    TIESRegistry public immutable registry;
    /// @notice The settlement engine, read for the pay cursor when claiming.
    ISettlementEngine public engine;

    uint256 public eventCount;
    uint256 public policyCount;
    mapping(uint256 => EventData) private _events;
    mapping(uint256 => ThresholdIndex.Tree) private _trees;
    mapping(uint256 => Policy) private _policies;
    mapping(address => uint256[]) private _policiesOf;

    /// @notice An insured event was created.
    event EventCreated(
        uint256 indexed eventId,
        uint8 indexed category,
        string label,
        uint64 cutoff,
        uint64 observationEnd
    );
    /// @notice A policy was bound.
    event PolicyBound(
        uint256 indexed policyId,
        uint256 indexed eventId,
        address indexed holder,
        uint256 bucket,
        uint256 payout,
        uint256 premium
    );
    /// @notice A settled policy was paid.
    event Claimed(uint256 indexed policyId, address indexed holder, uint256 amount);
    /// @notice The settlement engine address changed.
    event EngineSet(address engine);

    error UnknownEvent(uint256 eventId);
    error UnknownPolicy(uint256 policyId);
    error InvalidEventTimes();
    error CutoffPassed(uint256 cutoff);
    error BucketOutOfRange(uint256 bucket, uint256 bucketCount);
    error ZeroPayout();
    error InsufficientPremium(uint256 sent, uint256 required);
    error NoActiveSources(uint8 category);
    error CapacityWindowExceeded(uint256 bucket, uint256 used, uint256 cap);
    error EventShareExceeded(uint256 eventLocked, uint256 allowed);
    error InsufficientVaultLiquidity(uint256 payout, uint256 free);
    error NotSettledPaying(uint256 policyId, uint256 bucket, int256 payCursor);
    error AlreadyClaimed(uint256 policyId);
    error EngineNotSet();
    error RangeTooLarge(uint256 length);
    error TransferFailed();
    error RefundFailed();

    /// @param vault_ The liquidity vault.
    /// @param registry_ The registry.
    /// @param admin Account receiving the admin role.
    constructor(Vault vault_, TIESRegistry registry_, address admin) {
        vault = vault_;
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ----------------------------------------------------------------------- admin

    /// @notice Set the settlement engine whose pay cursor gates claims.
    /// @param engine_ The engine address.
    function setEngine(address engine_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        engine = ISettlementEngine(engine_);
        emit EngineSet(engine_);
    }

    /// @notice Create an insured event. Snapshots the category's current parameter version.
    /// @param category Category id.
    /// @param label Display label, e.g. "AI 101 DEL-BOM 2026-10-12".
    /// @param observationKey Key the sources are queried with, e.g. "AI101|2026-10-12".
    /// @param cutoff Binding closes at this timestamp.
    /// @param observationEnd Oracle rounds can open from this timestamp (>= cutoff).
    /// @return eventId The new event id (1-based).
    function createEvent(
        uint8 category,
        string calldata label,
        string calldata observationKey,
        uint64 cutoff,
        uint64 observationEnd
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 eventId) {
        if (cutoff <= block.timestamp || observationEnd < cutoff) revert InvalidEventTimes();
        uint256 version = registry.latestVersion(category);
        eventId = ++eventCount;
        EventData storage e = _events[eventId];
        e.exists = true;
        e.category = category;
        e.version = uint32(version);
        e.cutoff = cutoff;
        e.observationEnd = observationEnd;
        e.label = label;
        e.observationKey = observationKey;
        emit EventCreated(eventId, category, label, cutoff, observationEnd);
    }

    // -------------------------------------------------------------------- binding

    /// @notice Premium the contract charges for a policy.
    /// @dev premium = ceil(payout * q(threshold) * (1 + margin)) + escalationFee.
    /// @param eventId The event.
    /// @param bucket Threshold bucket (threshold = bucket * bucketWidth).
    /// @param payout Payout in wei.
    /// @return The premium in wei.
    function quote(uint256 eventId, uint256 bucket, uint256 payout) public view returns (uint256) {
        EventData storage e = _event(eventId);
        TIESRegistry.CategoryParams memory p = registry.getParams(e.category, e.version);
        return _quote(p, bucket, payout);
    }

    /// @notice Bind a policy: pays `payout` if the true value is at least the bucket threshold.
    ///         Locks `payout` in the vault, forwards the premium to it and refunds any excess.
    /// @param eventId The event.
    /// @param bucket Threshold bucket.
    /// @param payout Payout in wei.
    /// @return policyId The new policy id (1-based).
    function bind(
        uint256 eventId,
        uint256 bucket,
        uint256 payout
    ) external payable nonReentrant returns (uint256 policyId) {
        EventData storage e = _event(eventId);
        if (block.timestamp >= e.cutoff) revert CutoffPassed(e.cutoff);
        if (payout == 0) revert ZeroPayout();
        TIESRegistry.CategoryParams memory p = registry.getParams(e.category, e.version);
        if (bucket >= p.bucketCount) revert BucketOutOfRange(bucket, p.bucketCount);

        uint256 premium = _quote(p, bucket, payout);
        if (msg.value < premium) revert InsufficientPremium(msg.value, premium);

        _checkCapacity(eventId, e, p, bucket, payout);

        _trees[eventId].add(p.bucketCount, bucket, payout);
        e.locked += payout;
        policyId = ++policyCount;
        _policies[policyId] = Policy(eventId, msg.sender, uint32(bucket), false, payout, premium);
        _policiesOf[msg.sender].push(policyId);
        emit PolicyBound(policyId, eventId, msg.sender, bucket, payout, premium);

        vault.lock(payout);
        (bool ok, ) = address(vault).call{value: premium}("");
        if (!ok) revert TransferFailed();
        if (msg.value > premium) {
            (bool refunded, ) = msg.sender.call{value: msg.value - premium}("");
            if (!refunded) revert RefundFailed();
        }
    }

    /// @notice Claim the payout of a policy whose bucket the engine has settled as paying (O(1)).
    /// @param policyId The policy.
    function claim(uint256 policyId) external nonReentrant {
        Policy storage pol = _policies[policyId];
        if (pol.holder == address(0)) revert UnknownPolicy(policyId);
        if (pol.claimed) revert AlreadyClaimed(policyId);
        if (address(engine) == address(0)) revert EngineNotSet();
        int256 cursor = engine.payCursor(pol.eventId);
        if (int256(uint256(pol.bucket)) > cursor) {
            revert NotSettledPaying(policyId, pol.bucket, cursor);
        }
        pol.claimed = true;
        emit Claimed(policyId, pol.holder, pol.payout);
        vault.payClaim(pol.holder, pol.payout);
    }

    // ------------------------------------------------------------------------ views

    /// @notice Read an event.
    /// @param eventId The event.
    /// @return The event data.
    function eventData(uint256 eventId) external view returns (EventData memory) {
        return _event(eventId);
    }

    /// @notice Read a policy.
    /// @param policyId The policy.
    /// @return The policy data.
    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        Policy storage pol = _policies[policyId];
        if (pol.holder == address(0)) revert UnknownPolicy(policyId);
        return pol;
    }

    /// @notice Policy ids bound by an account.
    /// @param holder The account.
    /// @return Policy ids in binding order.
    function policiesOf(address holder) external view returns (uint256[] memory) {
        return _policiesOf[holder];
    }

    /// @notice Total collateral locked on an event.
    /// @param eventId The event.
    /// @return Locked collateral in wei.
    function eventLocked(uint256 eventId) external view returns (uint256) {
        return _event(eventId).locked;
    }

    /// @notice Collateral bound on buckets from..to (inclusive, clamped to the axis; from and to may
    ///         be negative or past the end, so engine cursors can be passed directly).
    /// @param eventId The event.
    /// @param from First bucket.
    /// @param to Last bucket.
    /// @return Collateral in wei.
    function rangeCollateral(
        uint256 eventId,
        int256 from,
        int256 to
    ) external view returns (uint256) {
        EventData storage e = _event(eventId);
        return _trees[eventId].range(_bucketCount(e), from, to);
    }

    /// @notice Per-bucket collateral for buckets from..to (inclusive, at most 1024 buckets).
    /// @param eventId The event.
    /// @param from First bucket.
    /// @param to Last bucket.
    /// @return amounts Collateral per bucket, index 0 = bucket `from`.
    function bucketsInRange(
        uint256 eventId,
        uint256 from,
        uint256 to
    ) external view returns (uint256[] memory amounts) {
        EventData storage e = _event(eventId);
        uint256 size = _bucketCount(e);
        if (to < from || to >= size) revert BucketOutOfRange(to, size);
        uint256 length = to - from + 1;
        if (length > MAX_VIEW_RANGE) revert RangeTooLarge(length);
        amounts = new uint256[](length);
        ThresholdIndex.Tree storage t = _trees[eventId];
        uint256 prev = t.prefix(size, int256(from) - 1);
        for (uint256 i = 0; i < length; i++) {
            uint256 cur = t.prefix(size, int256(from + i));
            amounts[i] = cur - prev;
            prev = cur;
        }
    }

    /// @notice Half-width, in buckets, of the capacity window used when binding on this event.
    /// @param eventId The event.
    /// @return w Window half-width.
    function windowOf(uint256 eventId) public view returns (uint256 w) {
        EventData storage e = _event(eventId);
        TIESRegistry.CategoryParams memory p = registry.getParams(e.category, e.version);
        return _window(e.category, p);
    }

    /// @notice Capacity still available in the window around a bucket.
    /// @param eventId The event.
    /// @param bucket Centre bucket.
    /// @return Remaining capacity in wei (0 if the window is full).
    function capacityLeftNear(uint256 eventId, uint256 bucket) public view returns (uint256) {
        EventData storage e = _event(eventId);
        TIESRegistry.CategoryParams memory p = registry.getParams(e.category, e.version);
        uint256 used = _windowUsed(eventId, p, e.category, bucket);
        return used >= p.capacityCapPerWindow ? 0 : p.capacityCapPerWindow - used;
    }

    /// @notice Nearest bucket (searching up to 64 buckets either way, ties go to the higher bucket)
    ///         whose window can take `payout` more collateral; reverts if none is found.
    /// @param eventId The event.
    /// @param bucket Starting bucket.
    /// @param payout Payout to place.
    /// @return The suggested bucket.
    function nearestAvailableBucket(
        uint256 eventId,
        uint256 bucket,
        uint256 payout
    ) external view returns (uint256) {
        EventData storage e = _event(eventId);
        TIESRegistry.CategoryParams memory p = registry.getParams(e.category, e.version);
        for (uint256 d = 0; d <= MAX_SEARCH_RADIUS; d++) {
            if (bucket + d < p.bucketCount && _fits(eventId, e, p, bucket + d, payout)) {
                return bucket + d;
            }
            if (d <= bucket && d != 0 && _fits(eventId, e, p, bucket - d, payout)) {
                return bucket - d;
            }
        }
        revert CapacityWindowExceeded(bucket, 0, p.capacityCapPerWindow);
    }

    // -------------------------------------------------------------------- internals

    function _event(uint256 eventId) private view returns (EventData storage e) {
        e = _events[eventId];
        if (!e.exists) revert UnknownEvent(eventId);
    }

    function _bucketCount(EventData storage e) private view returns (uint256) {
        return registry.getParams(e.category, e.version).bucketCount;
    }

    function _quote(
        TIESRegistry.CategoryParams memory p,
        uint256 bucket,
        uint256 payout
    ) private pure returns (uint256) {
        uint256 q = TIESMath.interpolate(p.curveTheta, p.curveProb, bucket * p.bucketWidth);
        uint256 risk = TIESMath.mulWadUp(payout, q);
        return TIESMath.mulWadUp(risk, WAD + p.margin) + p.escalationFee;
    }

    function _window(
        uint8 category,
        TIESRegistry.CategoryParams memory p
    ) private view returns (uint256) {
        uint256 sources = registry.activeSourceCount(category);
        if (sources == 0) revert NoActiveSources(category);
        return
            TIESMath.attainableWindow(sources, p.rho0, p.sigmaFloor, p.zByRound[0], p.bucketWidth);
    }

    function _windowUsed(
        uint256 eventId,
        TIESRegistry.CategoryParams memory p,
        uint8 category,
        uint256 bucket
    ) private view returns (uint256) {
        int256 w = int256(_window(category, p));
        int256 b = int256(bucket);
        return _trees[eventId].range(p.bucketCount, b - w, b + w);
    }

    function _checkCapacity(
        uint256 eventId,
        EventData storage e,
        TIESRegistry.CategoryParams memory p,
        uint256 bucket,
        uint256 payout
    ) private view {
        uint256 used = _windowUsed(eventId, p, e.category, bucket) + payout;
        if (used > p.capacityCapPerWindow) {
            revert CapacityWindowExceeded(bucket, used, p.capacityCapPerWindow);
        }
        uint256 free = vault.freeLiquidity();
        uint256 allowed = Math.mulDiv(p.eta, free, WAD);
        if (e.locked + payout > allowed) revert EventShareExceeded(e.locked + payout, allowed);
        if (free < payout) revert InsufficientVaultLiquidity(payout, free);
    }

    function _fits(
        uint256 eventId,
        EventData storage e,
        TIESRegistry.CategoryParams memory p,
        uint256 bucket,
        uint256 payout
    ) private view returns (bool) {
        return _windowUsed(eventId, p, e.category, bucket) + payout <= p.capacityCapPerWindow;
    }
}
