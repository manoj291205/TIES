// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Aggregation} from "../libraries/Aggregation.sol";
import {ISettlementEngine} from "../interfaces/ISettlementEngine.sol";
import {IOriginVerifier} from "../verifiers/IOriginVerifier.sol";
import {EscalationPlanner} from "./EscalationPlanner.sol";
import {LearningModule} from "./LearningModule.sol";
import {PolicyBook} from "./PolicyBook.sol";
import {TIESRegistry} from "./TIESRegistry.sol";
import {Vault} from "./Vault.sol";

/// @title SettlementEngine
/// @notice Runs oracle rounds for an event (commit, reveal, finalize), turns the evidence into a
///         running interval [L, U] and settles every policy below L as paying and every policy
///         above U as not paying with two range operations on the collateral index.
/// @dev Report values are milli-units. Cursors only ever move forward. Finalizing a round costs
///      the same regardless of how many policies exist, because it touches only the Fenwick tree
///      and a bounded list of at most 16 reports.
contract SettlementEngine is AccessControl, ReentrancyGuard, ISettlementEngine {
    uint256 private constant WAD = 1e18;
    /// @notice Bond a challenger posts against a pending default.
    uint256 public constant CHALLENGE_BOND = 0.05 ether;
    /// @notice Gas that must remain before the learning update runs, so a caller cannot make it
    ///         fail on purpose by supplying too little gas.
    uint256 public constant LEARNING_GAS_FLOOR = 6_000_000;
    /// @notice Gas forwarded when returning a bond, so the recipient cannot block a resolution.
    uint256 public constant BOND_REFUND_GAS = 50_000;

    /// @notice Lifecycle of an event after binding closes. Before the first round the event is
    ///         OPEN or CLOSED purely by time (status NONE here).
    enum Status {
        NONE,
        ROUND_COMMIT,
        ROUND_REVEAL,
        DEFAULT_PENDING,
        DISPUTED,
        FINAL
    }

    /// @notice Result of one finalized round.
    enum RoundOutcome {
        INSUFFICIENT,
        VALID,
        DISPUTED
    }

    /// @notice Why an event entered DISPUTED.
    enum DisputeReason {
        INCONSISTENT_EVIDENCE,
        CHALLENGED,
        INSUFFICIENT_EVIDENCE
    }

    struct EventState {
        Status status;
        uint8 round;
        DisputeReason disputeReason;
        bool hasInterval;
        uint32 bucketCount;
        uint8 category;
        uint32 version;
        uint32 maxReports;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 challengeDeadline;
        uint256 bucketWidth;
        uint256 lowerBound; // L, milli-units
        uint256 upperBound; // U, milli-units
        uint256 vLast; // consensus of the latest finalized round
        uint256 nEffLast; // WAD
        uint256 sigmaLast; // milli-units
        uint256 payCount; // buckets settled as paying (payCursor + 1)
        uint256 noPayCount; // buckets settled as not paying (bucketCount - noPayCursor)
        uint256 settledPay; // collateral settled as paying
        uint256 settledNoPay; // collateral settled as not paying
        address challenger;
        uint256 bond;
    }

    struct RoundSummary {
        uint256 eventId;
        uint8 round;
        RoundOutcome status;
        uint256 consensus;
        uint256 sigma;
        uint256 nEff;
        uint256 lower;
        uint256 upper;
        int256 payCursor;
        int256 noPayCursor;
        uint256 newPay;
        uint256 newNoPay;
        uint256 held;
    }

    struct Report {
        address oracle;
        uint32 sourceId;
        uint8 round;
        uint256 value;
    }

    Vault public immutable vault;
    PolicyBook public immutable book;
    TIESRegistry public immutable registry;
    IOriginVerifier public immutable verifier;
    EscalationPlanner public immutable planner;
    LearningModule public immutable learning;

    mapping(uint256 => EventState) internal _state;
    mapping(uint256 => Report[]) private _reports;
    mapping(uint256 => mapping(address => bool)) private _reported;
    mapping(uint256 => mapping(uint8 => address[])) private _committee;
    mapping(uint256 => mapping(uint8 => mapping(address => bytes32))) private _commits;
    /// @notice Returned bonds waiting to be withdrawn by challengers that could not receive them.
    mapping(address => uint256) public bondOwed;

    /// @notice A round opened for an event.
    event RoundOpened(
        uint256 indexed eventId,
        uint8 round,
        uint64 commitDeadline,
        uint64 revealDeadline,
        address[] committee
    );
    /// @notice An oracle committed to a report.
    event ReportCommitted(uint256 indexed eventId, uint8 round, address indexed oracle);
    /// @notice An oracle revealed a verified report.
    event ReportRevealed(
        uint256 indexed eventId,
        uint8 round,
        address indexed oracle,
        uint32 sourceId,
        uint256 value
    );
    /// @notice A round was finalized. L/U are the running intersection (0 / max before the first
    ///         valid interval), cursors are -1 / bucketCount when nothing is settled.
    event RoundFinalized(
        uint256 indexed eventId,
        uint8 round,
        RoundOutcome status,
        uint256 V,
        uint256 sigma,
        uint256 nEff,
        uint256 L,
        uint256 U,
        int256 payCursor,
        int256 noPayCursor,
        uint256 newPay,
        uint256 newNoPay,
        uint256 held
    );
    /// @notice The event moved to a new lifecycle status.
    event EventStatusChanged(uint256 indexed eventId, Status status);
    /// @notice More evidence is requested: a new round opens with oracles on sources that are not
    ///         yet represented.
    event EscalationRequested(
        uint256 indexed eventId,
        uint8 nextRound,
        uint256 k,
        address[] selected,
        uint256 held
    );
    /// @notice Held collateral remains and no further round is possible; a challenge window opened.
    event EventDefaultPending(uint256 indexed eventId, uint64 challengeDeadline);
    /// @notice A pending default was challenged with a bond.
    event EventChallenged(uint256 indexed eventId, address indexed challenger, uint256 bond);
    /// @notice The event was disputed.
    event EventDisputed(uint256 indexed eventId, DisputeReason reason);
    /// @notice The default rule settled the remaining collateral.
    event DefaultApplied(uint256 indexed eventId, uint256 value);
    /// @notice The admin resolved a dispute.
    event DisputeResolved(uint256 indexed eventId, uint256 finalValue);
    /// @notice All collateral of the event is settled.
    event EventFinalized(uint256 indexed eventId, uint256 finalValue);
    /// @notice The learning update reverted; settlement went ahead without it.
    event LearningSkipped(uint256 indexed eventId);
    /// @notice A returned bond could not be sent and is kept for `withdrawBond`.
    event BondOwed(address indexed challenger, uint256 amount);

    error WrongStatus(uint256 eventId, Status status);
    error WrongRound(uint8 expected, uint8 given);
    error ObservationNotEnded(uint256 observationEnd);
    error NoCommittee();
    error NotInCommittee(address account);
    error CommitWindowClosed(uint64 deadline);
    error CommitWindowOpen(uint64 deadline);
    error RevealWindowClosed(uint64 deadline);
    error RevealWindowOpen(uint64 deadline);
    error AlreadyCommitted();
    error EmptyCommit();
    error NoCommit();
    error CommitMismatch();
    error AlreadyReported(address oracle);
    error TooManyReports(uint256 max);
    error ChallengeWindowClosed(uint64 deadline);
    error ChallengeWindowOpen(uint64 deadline);
    error WrongBond(uint256 sent, uint256 required);
    error CursorRegression();
    error BondTransferFailed();
    error InsufficientGasForLearning();
    error NothingOwed();

    /// @param vault_ The liquidity vault (this contract needs ENGINE_ROLE on it).
    /// @param book_ The policy book.
    /// @param registry_ The registry.
    /// @param verifier_ The origin verifier.
    /// @param planner_ The escalation planner.
    /// @param learning_ The learning module.
    /// @param admin Account receiving the admin role (dispute resolution).
    constructor(
        Vault vault_,
        PolicyBook book_,
        TIESRegistry registry_,
        IOriginVerifier verifier_,
        EscalationPlanner planner_,
        LearningModule learning_,
        address admin
    ) {
        vault = vault_;
        book = book_;
        registry = registry_;
        verifier = verifier_;
        planner = planner_;
        learning = learning_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ----------------------------------------------------------------------- rounds

    /// @notice Open round 1 for an event once its observation window has ended. Anyone may call.
    ///         The committee is every active oracle flagged primary for the category.
    /// @param eventId The event.
    function openRound(uint256 eventId) external {
        EventState storage st = _state[eventId];
        if (st.status != Status.NONE) revert WrongStatus(eventId, st.status);
        (uint8 category, uint32 version, uint64 observationEnd, ) = book.eventMeta(eventId);
        if (block.timestamp < observationEnd) revert ObservationNotEnded(observationEnd);

        TIESRegistry.CategoryParams memory p = registry.getParams(category, version);
        address[] memory primary = registry.activePrimaryOracles(category);
        uint256 n = Math.min(primary.length, p.maxReportsPerEvent);
        if (n == 0) revert NoCommittee();
        address[] memory committee = new address[](n);
        for (uint256 i = 0; i < n; i++) committee[i] = primary[i];

        st.bucketCount = p.bucketCount;
        st.bucketWidth = p.bucketWidth;
        st.category = category;
        st.version = version;
        st.maxReports = p.maxReportsPerEvent;
        _beginRound(eventId, st, 1, committee, p.commitWindow, p.revealWindow);
    }

    /// @notice Commit to a report during the commit window. Only committee members may commit,
    ///         once per round.
    /// @param eventId The event.
    /// @param round The round being committed to.
    /// @param commitHash keccak256(abi.encode(value, ts, toolHash, argsHash, responseHash,
    ///        sourceSig, salt, msg.sender)).
    function commit(uint256 eventId, uint8 round, bytes32 commitHash) external {
        EventState storage st = _state[eventId];
        if (st.status != Status.ROUND_COMMIT) revert WrongStatus(eventId, st.status);
        if (round != st.round) revert WrongRound(st.round, round);
        if (block.timestamp >= st.commitDeadline) revert CommitWindowClosed(st.commitDeadline);
        if (!_isMember(eventId, round, msg.sender)) revert NotInCommittee(msg.sender);
        if (commitHash == bytes32(0)) revert EmptyCommit();
        if (_commits[eventId][round][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        _commits[eventId][round][msg.sender] = commitHash;
        emit ReportCommitted(eventId, round, msg.sender);
    }

    /// @notice Reveal a committed report during the reveal window. The source is derived by the
    ///         verifier from the signature, never taken from the caller.
    /// @param eventId The event.
    /// @param round The round.
    /// @param value Reported value (milli-units).
    /// @param ts Timestamp at which the source observed the value.
    /// @param toolHash Hash of the tool that produced the report.
    /// @param argsHash Hash of the tool arguments.
    /// @param responseHash Hash of the raw response.
    /// @param sourceSig The source adapter's signature over the report digest.
    /// @param salt Random salt used in the commit.
    function reveal(
        uint256 eventId,
        uint8 round,
        uint256 value,
        uint256 ts,
        bytes32 toolHash,
        bytes32 argsHash,
        bytes32 responseHash,
        bytes calldata sourceSig,
        bytes32 salt
    ) external {
        _reveal(
            eventId,
            round,
            IOriginVerifier.SourceReport(value, ts, toolHash, argsHash, responseHash, sourceSig),
            salt
        );
    }

    function _reveal(
        uint256 eventId,
        uint8 round,
        IOriginVerifier.SourceReport memory report,
        bytes32 salt
    ) private {
        EventState storage st = _state[eventId];
        if (st.status != Status.ROUND_COMMIT && st.status != Status.ROUND_REVEAL) {
            revert WrongStatus(eventId, st.status);
        }
        if (round != st.round) revert WrongRound(st.round, round);
        if (block.timestamp < st.commitDeadline) revert CommitWindowOpen(st.commitDeadline);
        if (block.timestamp >= st.revealDeadline) revert RevealWindowClosed(st.revealDeadline);

        bytes32 committed = _commits[eventId][round][msg.sender];
        if (committed == bytes32(0)) revert NoCommit();
        bytes32 expected = keccak256(
            abi.encode(
                report.value,
                report.ts,
                report.toolHash,
                report.argsHash,
                report.responseHash,
                report.sourceSig,
                salt,
                msg.sender
            )
        );
        if (committed != expected) revert CommitMismatch();
        if (_reported[eventId][msg.sender]) revert AlreadyReported(msg.sender);
        if (_reports[eventId].length >= st.maxReports) revert TooManyReports(st.maxReports);

        uint32 sourceId = _verify(eventId, report);

        _reported[eventId][msg.sender] = true;
        _reports[eventId].push(Report(msg.sender, sourceId, round, report.value));
        if (st.status == Status.ROUND_COMMIT) _setStatus(eventId, st, Status.ROUND_REVEAL);
        emit ReportRevealed(eventId, round, msg.sender, sourceId, report.value);
    }

    /// @notice Close the current round after its reveal deadline: aggregate all reports so far,
    ///         update the running interval, settle by range, and move the event on. Anyone may call.
    /// @param eventId The event.
    function finalizeRound(uint256 eventId) external nonReentrant {
        EventState storage st = _state[eventId];
        if (st.status != Status.ROUND_COMMIT && st.status != Status.ROUND_REVEAL) {
            revert WrongStatus(eventId, st.status);
        }
        if (block.timestamp < st.revealDeadline) revert RevealWindowOpen(st.revealDeadline);

        (uint8 category, uint32 version, , uint256 locked) = book.eventMeta(eventId);
        _closeRound(eventId, st, category, locked, registry.getParams(category, version));
    }

    function _closeRound(
        uint256 eventId,
        EventState storage st,
        uint8 category,
        uint256 locked,
        TIESRegistry.CategoryParams memory p
    ) private {
        uint8 round = st.round;
        Aggregation.Result memory r = _aggregate(eventId, category, p);
        RoundOutcome outcome = _applyEvidence(st, r, p, round);

        uint256 newPay;
        uint256 newNoPay;
        if (outcome == RoundOutcome.VALID) {
            (newPay, newNoPay) = _settleTo(eventId, st, st.lowerBound, st.upperBound);
        }
        uint256 heldAmount = locked - st.settledPay - st.settledNoPay;
        _emitRound(eventId, st, round, outcome, r, [newPay, newNoPay, heldAmount]);

        if (outcome == RoundOutcome.DISPUTED) {
            st.disputeReason = DisputeReason.INCONSISTENT_EVIDENCE;
            _setStatus(eventId, st, Status.DISPUTED);
            emit EventDisputed(eventId, DisputeReason.INCONSISTENT_EVIDENCE);
        } else if (heldAmount == 0) {
            _finalizeEvent(eventId, st, st.vLast);
        } else {
            _escalateOrDefault(eventId, st, p, r, outcome == RoundOutcome.INSUFFICIENT, heldAmount);
        }
    }

    // ------------------------------------------------------- defaults and disputes

    /// @notice Challenge a pending default by posting the fixed bond. Moves the event to DISPUTED.
    /// @param eventId The event.
    function challenge(uint256 eventId) external payable nonReentrant {
        EventState storage st = _state[eventId];
        if (st.status != Status.DEFAULT_PENDING) revert WrongStatus(eventId, st.status);
        if (block.timestamp >= st.challengeDeadline)
            revert ChallengeWindowClosed(st.challengeDeadline);
        if (msg.value != CHALLENGE_BOND) revert WrongBond(msg.value, CHALLENGE_BOND);
        st.challenger = msg.sender;
        st.bond = msg.value;
        st.disputeReason = DisputeReason.CHALLENGED;
        _setStatus(eventId, st, Status.DISPUTED);
        emit EventChallenged(eventId, msg.sender, msg.value);
        emit EventDisputed(eventId, DisputeReason.CHALLENGED);
    }

    /// @notice After the challenge period, settle the remaining collateral at the last consensus
    ///         value, clamped into the running interval [L, U]. Anyone may call.
    /// @param eventId The event.
    function applyDefault(uint256 eventId) external nonReentrant {
        EventState storage st = _state[eventId];
        if (st.status != Status.DEFAULT_PENDING) revert WrongStatus(eventId, st.status);
        if (block.timestamp < st.challengeDeadline)
            revert ChallengeWindowOpen(st.challengeDeadline);
        // A pending default always has a valid interval; the value is kept inside it.
        uint256 value = Math.min(Math.max(st.vLast, st.lowerBound), st.upperBound);
        _settleTo(eventId, st, value, value);
        st.lowerBound = value;
        st.upperBound = value;
        emit DefaultApplied(eventId, value);
        _finalizeEvent(eventId, st, value);
    }

    /// @notice Resolve a disputed event at an admin-chosen final value. A challenger whose claim
    ///         is upheld (final value differs from the last consensus by more than the error
    ///         tolerance) gets the bond back; otherwise the bond goes to the vault.
    /// @param eventId The event.
    /// @param finalValue The final value (milli-units).
    function resolveDispute(
        uint256 eventId,
        uint256 finalValue
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        EventState storage st = _state[eventId];
        if (st.status != Status.DISPUTED) revert WrongStatus(eventId, st.status);
        _settleTo(eventId, st, finalValue, finalValue);
        st.lowerBound = finalValue;
        st.upperBound = finalValue;
        st.hasInterval = true;

        uint256 bond = st.bond;
        bool upheld;
        if (bond > 0) {
            (uint8 category, uint32 version, , ) = book.eventMeta(eventId);
            TIESRegistry.CategoryParams memory p = registry.getParams(category, version);
            uint256 tolerance = Math.mulDiv(p.eps, p.s, WAD);
            uint256 gap = finalValue > st.vLast ? finalValue - st.vLast : st.vLast - finalValue;
            st.bond = 0;
            upheld = gap > tolerance;
        }
        emit DisputeResolved(eventId, finalValue);
        _finalizeEvent(eventId, st, finalValue);
        if (bond > 0) _payBond(st.challenger, bond, upheld);
    }

    /// @notice Withdraw a returned challenge bond that could not be sent directly.
    function withdrawBond() external nonReentrant {
        uint256 amount = bondOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        bondOwed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert BondTransferFailed();
    }

    // ------------------------------------------------------------------------ views

    /// @inheritdoc ISettlementEngine
    function payCursor(uint256 eventId) external view returns (int256) {
        return int256(_state[eventId].payCount) - 1;
    }

    /// @notice Smallest bucket settled as not paying (bucketCount if none; 0 before the first round).
    /// @param eventId The event.
    /// @return The no-pay cursor.
    function noPayCursor(uint256 eventId) external view returns (int256) {
        EventState storage st = _state[eventId];
        return int256(uint256(st.bucketCount)) - int256(st.noPayCount);
    }

    /// @notice Collateral of the event that is neither settled paying nor not paying.
    /// @param eventId The event.
    /// @return Held collateral in wei.
    function held(uint256 eventId) external view returns (uint256) {
        (, , , uint256 locked) = book.eventMeta(eventId);
        EventState storage st = _state[eventId];
        return locked - st.settledPay - st.settledNoPay;
    }

    /// @notice Settlement state of an event.
    /// @param eventId The event.
    /// @return The state struct.
    function eventState(uint256 eventId) external view returns (EventState memory) {
        return _state[eventId];
    }

    /// @notice Number of reports revealed for an event so far.
    /// @param eventId The event.
    /// @return Report count.
    function reportCount(uint256 eventId) external view returns (uint256) {
        return _reports[eventId].length;
    }

    /// @notice A revealed report.
    /// @param eventId The event.
    /// @param index Position (reveal order).
    /// @return The report.
    function reportAt(uint256 eventId, uint256 index) external view returns (Report memory) {
        return _reports[eventId][index];
    }

    /// @notice Committee of a round.
    /// @param eventId The event.
    /// @param round The round.
    /// @return The committee addresses.
    function committeeOf(uint256 eventId, uint8 round) external view returns (address[] memory) {
        return _committee[eventId][round];
    }

    /// @notice The commit hash an oracle stored for a round (zero if none).
    /// @param eventId The event.
    /// @param round The round.
    /// @param oracle The oracle.
    /// @return The commit hash.
    function commitOf(
        uint256 eventId,
        uint8 round,
        address oracle
    ) external view returns (bytes32) {
        return _commits[eventId][round][oracle];
    }

    // -------------------------------------------------------------------- internals

    function _beginRound(
        uint256 eventId,
        EventState storage st,
        uint8 round,
        address[] memory committee,
        uint64 commitWindow,
        uint64 revealWindow
    ) internal {
        st.round = round;
        st.commitDeadline = uint64(block.timestamp) + commitWindow;
        st.revealDeadline = st.commitDeadline + revealWindow;
        _committee[eventId][round] = committee;
        _setStatus(eventId, st, Status.ROUND_COMMIT);
        emit RoundOpened(eventId, round, st.commitDeadline, st.revealDeadline, committee);
    }

    function _setStatus(uint256 eventId, EventState storage st, Status status) private {
        st.status = status;
        emit EventStatusChanged(eventId, status);
    }

    function _isMember(uint256 eventId, uint8 round, address who) private view returns (bool) {
        address[] storage list = _committee[eventId][round];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == who) return true;
        }
        return false;
    }

    function _verify(
        uint256 eventId,
        IOriginVerifier.SourceReport memory report
    ) private view returns (uint32) {
        (uint8 category, , uint64 observationEnd, ) = book.eventMeta(eventId);
        return verifier.verify(eventId, category, observationEnd, report);
    }

    /// @dev Builds the aggregation input from every revealed report of the event.
    function _aggregate(
        uint256 eventId,
        uint8 category,
        TIESRegistry.CategoryParams memory p
    ) private view returns (Aggregation.Result memory r) {
        Report[] storage reports = _reports[eventId];
        uint256 n = reports.length;
        if (n == 0) return r;

        Aggregation.Input memory in_;
        in_.x = new uint256[](n);
        in_.rep = new uint256[](n);
        in_.rho = new uint256[](n * n);
        in_.s = p.s;
        in_.sigmaFloor = p.sigmaFloor;
        in_.delta = p.delta;
        in_.dCut = p.dCut;
        for (uint256 i = 0; i < n; i++) {
            Report storage a = reports[i];
            in_.x[i] = a.value;
            in_.rep[i] = registry.reputationWeight(a.oracle, category);
            for (uint256 j = 0; j < i; j++) {
                uint32 other = reports[j].sourceId;
                uint256 rho = other == a.sourceId
                    ? WAD
                    : registry.dependence(a.sourceId, other, p.rho0);
                in_.rho[i * n + j] = rho;
                in_.rho[j * n + i] = rho;
            }
        }
        r = Aggregation.run(in_);
    }

    /// @dev Spec 3.5 steps 9-11: sufficiency gate, round interval and running intersection.
    function _applyEvidence(
        EventState storage st,
        Aggregation.Result memory r,
        TIESRegistry.CategoryParams memory p,
        uint8 round
    ) private returns (RoundOutcome) {
        if (r.weightSum == 0) return RoundOutcome.INSUFFICIENT;
        st.vLast = r.consensus;
        st.nEffLast = r.nEff;
        st.sigmaLast = r.sigma;
        if (r.nEff < p.nMin) return RoundOutcome.INSUFFICIENT;

        uint256 half = Math.mulDiv(p.zByRound[round - 1], r.sigma, WAD);
        uint256 lo = r.consensus > half ? r.consensus - half : 0;
        uint256 hi = r.consensus + half;
        if (!st.hasInterval) {
            st.lowerBound = lo;
            st.upperBound = hi;
            st.hasInterval = true;
            return RoundOutcome.VALID;
        }
        uint256 newLower = Math.max(st.lowerBound, lo);
        uint256 newUpper = Math.min(st.upperBound, hi);
        if (newLower > newUpper) return RoundOutcome.DISPUTED;
        st.lowerBound = newLower;
        st.upperBound = newUpper;
        return RoundOutcome.VALID;
    }

    /// @dev Spec 3.6. Settles by range: buckets with threshold <= lower pay, buckets with
    ///      threshold > upper do not. Cursors are clamped so settled buckets never reverse and the
    ///      two ranges never overlap (identical to the spec on every ordinary path).
    function _settleTo(
        uint256 eventId,
        EventState storage st,
        uint256 lower,
        uint256 upper
    ) private returns (uint256 newPay, uint256 newNoPay) {
        int256 buckets = int256(uint256(st.bucketCount));
        int256 oldPay = int256(st.payCount) - 1;
        int256 oldNoPay = buckets - int256(st.noPayCount);

        int256 payTo = int256(Math.min(lower / st.bucketWidth, uint256(buckets - 1)));
        payTo = _max(payTo, oldPay);
        payTo = _min(payTo, oldNoPay - 1);
        int256 noPayFrom = int256(Math.min(upper / st.bucketWidth + 1, uint256(buckets)));
        noPayFrom = _min(noPayFrom, oldNoPay);
        noPayFrom = _max(noPayFrom, payTo + 1);
        if (payTo < oldPay || noPayFrom > oldNoPay) revert CursorRegression();

        if (payTo > oldPay) {
            newPay = book.rangeCollateral(eventId, oldPay + 1, payTo);
            if (newPay > 0) vault.moveLockedToClaimable(newPay);
        }
        if (noPayFrom < oldNoPay) {
            newNoPay = book.rangeCollateral(eventId, noPayFrom, oldNoPay - 1);
            if (newNoPay > 0) vault.unlock(newNoPay);
        }
        st.payCount = uint256(payTo + 1);
        st.noPayCount = uint256(buckets - noPayFrom);
        st.settledPay += newPay;
        st.settledNoPay += newNoPay;
    }

    function _emitRound(
        uint256 eventId,
        EventState storage st,
        uint8 round,
        RoundOutcome outcome,
        Aggregation.Result memory r,
        uint256[3] memory amounts
    ) private {
        RoundSummary memory m;
        m.eventId = eventId;
        m.round = round;
        m.status = outcome;
        m.consensus = r.consensus;
        m.sigma = r.sigma;
        m.nEff = r.nEff;
        m.lower = st.hasInterval ? st.lowerBound : 0;
        m.upper = st.hasInterval ? st.upperBound : type(uint256).max;
        m.payCursor = int256(st.payCount) - 1;
        m.noPayCursor = int256(uint256(st.bucketCount)) - int256(st.noPayCount);
        m.newPay = amounts[0];
        m.newNoPay = amounts[1];
        m.held = amounts[2];
        _emitSummary(m);
    }

    function _emitSummary(RoundSummary memory m) private {
        emit RoundFinalized(
            m.eventId,
            m.round,
            m.status,
            m.consensus,
            m.sigma,
            m.nEff,
            m.lower,
            m.upper,
            m.payCursor,
            m.noPayCursor,
            m.newPay,
            m.newNoPay,
            m.held
        );
    }

    /// @dev Spec 3.7 steps 2-3. Escalates while rounds and report capacity remain and either the
    ///      evidence is insufficient or more than `uMin` is still held. Otherwise, if a valid
    ///      interval exists, opens the challenge window before the default rule applies. If no
    ///      round ever produced a valid interval the event is disputed instead: collateral never
    ///      moves on evidence from fewer than N_min independent sources.
    function _escalateOrDefault(
        uint256 eventId,
        EventState storage st,
        TIESRegistry.CategoryParams memory p,
        Aggregation.Result memory r,
        bool insufficient,
        uint256 heldAmount
    ) private {
        uint256 room = st.maxReports - _reports[eventId].length;
        if (st.round < p.kMax && room > 0 && (insufficient || heldAmount > p.uMin)) {
            (bool escalate, uint256 k, address[] memory selected) = planner.plan(
                _planInput(eventId, st, r, insufficient)
            );
            if (escalate) {
                if (selected.length > room) {
                    address[] memory fitting = new address[](room);
                    for (uint256 i = 0; i < room; i++) fitting[i] = selected[i];
                    selected = fitting;
                }
                emit EscalationRequested(eventId, st.round + 1, k, selected, heldAmount);
                _beginRound(eventId, st, st.round + 1, selected, p.commitWindow, p.revealWindow);
                return;
            }
        }
        if (!st.hasInterval) {
            st.disputeReason = DisputeReason.INSUFFICIENT_EVIDENCE;
            _setStatus(eventId, st, Status.DISPUTED);
            emit EventDisputed(eventId, DisputeReason.INSUFFICIENT_EVIDENCE);
            return;
        }
        st.challengeDeadline = uint64(block.timestamp) + p.challengePeriod;
        _setStatus(eventId, st, Status.DEFAULT_PENDING);
        emit EventDefaultPending(eventId, st.challengeDeadline);
    }

    /// @dev Groups the reports by source and passes what the planner needs.
    function _planInput(
        uint256 eventId,
        EventState storage st,
        Aggregation.Result memory r,
        bool insufficient
    ) private view returns (EscalationPlanner.PlanInput memory in_) {
        Report[] storage reports = _reports[eventId];
        uint256 n = reports.length;
        in_.eventId = eventId;
        in_.category = st.category;
        in_.version = st.version;
        in_.round = st.round;
        in_.hasConsensus = r.weightSum > 0;
        in_.insufficient = insufficient;
        in_.payCursor = int256(st.payCount) - 1;
        in_.noPayCursor = int256(uint256(st.bucketCount)) - int256(st.noPayCount);
        in_.consensus = r.consensus;
        in_.sigma = r.sigma;
        in_.nEff = r.nEff;
        in_.reporters = _usedOracles(eventId, st.round, reports);

        uint32[] memory ids = new uint32[](n);
        uint256[] memory weights = new uint256[](n);
        uint256 distinct;
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = distinct;
            for (uint256 j = 0; j < distinct; j++) {
                if (ids[j] == reports[i].sourceId) {
                    slot = j;
                    break;
                }
            }
            if (slot == distinct) {
                ids[distinct] = reports[i].sourceId;
                distinct++;
            }
            weights[slot] += r.weights[i];
        }
        in_.sourceIds = new uint32[](distinct);
        in_.sourceWeights = new uint256[](distinct);
        for (uint256 j = 0; j < distinct; j++) {
            in_.sourceIds[j] = ids[j];
            in_.sourceWeights[j] = weights[j];
        }
    }

    /// @dev Oracles the planner must not recruit again: every oracle that revealed a report, and
    ///      every committee member that committed in an earlier round and then withheld its reveal
    ///      (re-recruiting it would only spend another round; a withholding oracle could otherwise
    ///      stall the event until the round limit). A member that never committed stays eligible.
    function _usedOracles(
        uint256 eventId,
        uint8 rounds,
        Report[] storage reports
    ) private view returns (address[] memory out) {
        uint256 bound = reports.length;
        for (uint8 r = 1; r <= rounds; r++) bound += _committee[eventId][r].length;
        address[] memory tmp = new address[](bound);
        uint256 count;
        for (uint256 i = 0; i < reports.length; i++) tmp[count++] = reports[i].oracle;
        for (uint8 r = 1; r <= rounds; r++) {
            address[] storage members = _committee[eventId][r];
            for (uint256 i = 0; i < members.length; i++) {
                address who = members[i];
                if (_reported[eventId][who] || _commits[eventId][r][who] == bytes32(0)) continue;
                bool seen;
                for (uint256 j = 0; j < count; j++) {
                    if (tmp[j] == who) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) tmp[count++] = who;
            }
        }
        out = new address[](count);
        for (uint256 i = 0; i < count; i++) out[i] = tmp[i];
    }

    /// @dev Marks the event final and lets reputation and dependence learn from the outcome.
    function _finalizeEvent(uint256 eventId, EventState storage st, uint256 finalValue) private {
        _setStatus(eventId, st, Status.FINAL);
        emit EventFinalized(eventId, finalValue);
        _learn(eventId, st, finalValue);
    }

    function _learn(uint256 eventId, EventState storage st, uint256 finalValue) private {
        Report[] storage reports = _reports[eventId];
        address[] memory silent = _silentMembers(eventId, st.round);
        uint256 n = reports.length;
        if (n == 0 && silent.length == 0) return;

        LearningModule.LearnInput memory in_;
        in_.eventId = eventId;
        in_.category = st.category;
        in_.version = st.version;
        in_.finalValue = finalValue;
        (, , , in_.total) = book.eventMeta(eventId);
        in_.oracles = new address[](n);
        in_.sources = new uint32[](n);
        in_.values = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            in_.oracles[i] = reports[i].oracle;
            in_.sources[i] = reports[i].sourceId;
            in_.values[i] = reports[i].value;
        }
        in_.silent = silent;
        if (gasleft() < LEARNING_GAS_FLOOR) revert InsufficientGasForLearning();
        try learning.learn(in_) {} catch {
            emit LearningSkipped(eventId);
        }
    }

    /// @dev Committee members, across all rounds, that never revealed (each listed once).
    function _silentMembers(
        uint256 eventId,
        uint8 rounds
    ) private view returns (address[] memory out) {
        uint256 bound;
        for (uint8 r = 1; r <= rounds; r++) bound += _committee[eventId][r].length;
        address[] memory tmp = new address[](bound);
        uint256 count;
        for (uint8 r = 1; r <= rounds; r++) {
            address[] storage members = _committee[eventId][r];
            for (uint256 i = 0; i < members.length; i++) {
                address who = members[i];
                if (_reported[eventId][who]) continue;
                bool seen;
                for (uint256 j = 0; j < count; j++) {
                    if (tmp[j] == who) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) tmp[count++] = who;
            }
        }
        out = new address[](count);
        for (uint256 i = 0; i < count; i++) out[i] = tmp[i];
    }

    /// @dev Runs last in resolveDispute. A returned bond is pushed with a gas cap so a challenger
    ///      contract cannot block the resolution; if the push fails the bond is kept for
    ///      `withdrawBond`. A forfeited bond goes to the vault.
    function _payBond(address challenger, uint256 bond, bool upheld) private {
        if (upheld) {
            (bool ok, ) = challenger.call{value: bond, gas: BOND_REFUND_GAS}("");
            if (!ok) {
                bondOwed[challenger] += bond;
                emit BondOwed(challenger, bond);
            }
            return;
        }
        (bool toVault, ) = address(vault).call{value: bond}("");
        if (!toVault) revert BondTransferFailed();
    }

    function _max(int256 a, int256 b) private pure returns (int256) {
        return a > b ? a : b;
    }

    function _min(int256 a, int256 b) private pure returns (int256) {
        return a < b ? a : b;
    }
}
