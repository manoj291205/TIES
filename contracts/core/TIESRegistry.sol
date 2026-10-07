// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TIESRegistry
/// @notice Configuration and learned state: category parameters, upstream sources, oracles, their
///         per-category reputation and the learned dependence between sources.
/// @dev Category parameters are versioned. Changing a category appends a new version; an event stores
///      the version current at its creation, so later edits never affect it. Sources, oracles,
///      reputation and dependence are live values shared across events.
contract TIESRegistry is AccessControl {
    /// @notice Role held by the settlement engine (reputation and dependence updates).
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");

    uint256 public constant WAD = 1e18;
    /// @notice Upper bound on oracles per category; bounds every loop over the oracle list.
    uint256 public constant MAX_ORACLES_PER_CATEGORY = 64;

    /// @notice Full parameter set of a category. Value units are described per field.
    struct CategoryParams {
        string unit; // display only, e.g. "min" or "mm"
        uint32 bucketCount; // number of threshold buckets B
        uint32 maxReportsPerEvent; // bounds aggregation loops
        uint8 kMax; // maximum rounds
        uint8 kRound; // maximum recruits per round
        uint64 commitWindow; // seconds
        uint64 revealWindow; // seconds
        uint64 challengePeriod; // seconds
        uint256 bucketWidth; // milli-units
        uint256 s; // deviation scale, milli-units
        uint256 sigmaFloor; // irreducible noise, milli-units
        uint256 delta; // kernel width in s units, WAD
        uint256 dCut; // hard outlier cut in s units, WAD
        uint256 nMin; // minimum N_eff for any movement, WAD
        uint256 rho0; // prior dependence between distinct sources, WAD
        uint256 uMin; // escalation trigger on held collateral, wei
        uint256 rMin; // minimum reputation to be recruited, WAD
        uint256 alpha0; // initial reputation alpha, WAD
        uint256 beta0; // initial reputation beta, WAD
        uint256 gamma; // reputation decay per event, WAD
        uint256 mu; // dependence learning rate, WAD
        uint256 eps; // error tolerance in s units, WAD
        uint256 capacityCapPerWindow; // wei
        uint256 eta; // max share of free liquidity per event, WAD
        uint256 margin; // pricing margin, WAD
        uint256 escalationFee; // wei
        uint256[] zByRound; // z value per round, WAD
        uint256[] curveTheta; // exceedance curve x (milli-units), strictly increasing
        uint256[] curveProb; // exceedance curve y (WAD), non-increasing
    }

    struct Source {
        address signer;
        uint8 category;
        bool active;
        string name;
    }

    struct Oracle {
        bool registered;
        bool active;
        bool primary;
        uint32 sourceId;
        uint256 alpha;
        uint256 beta;
    }

    mapping(uint8 => CategoryParams[]) private _versions;

    uint32 public sourceCount;
    mapping(uint32 => Source) private _sources;
    mapping(address => uint32) public sourceIdOfSigner;
    mapping(uint32 => mapping(bytes32 => bool)) public toolHashAllowed;
    mapping(uint8 => uint256) public activeSourceCount;

    mapping(address => mapping(uint8 => Oracle)) private _oracles;
    mapping(uint8 => address[]) private _oracleList;
    mapping(address => uint256) private _registrations;

    mapping(bytes32 => uint256) private _rho;

    /// @notice A new parameter version was stored for a category.
    event CategoryUpdated(uint8 indexed category, uint256 version);
    /// @notice An upstream source was registered.
    event SourceRegistered(
        uint32 indexed sourceId,
        address indexed signer,
        uint8 indexed category,
        string name
    );
    /// @notice A source was activated or deactivated.
    event SourceUpdated(uint32 indexed sourceId, bool active);
    /// @notice A tool hash was allowed or disallowed for a source.
    event ToolHashUpdated(uint32 indexed sourceId, bytes32 toolHash, bool allowed);
    /// @notice An oracle was registered for a category.
    event OracleRegistered(
        address indexed oracle,
        uint8 indexed category,
        uint32 sourceId,
        bool primary
    );
    /// @notice An oracle's source, primary flag or active flag changed.
    event OracleUpdated(
        address indexed oracle,
        uint8 indexed category,
        uint32 sourceId,
        bool primary,
        bool active
    );
    /// @notice An oracle's category reputation changed.
    event ReputationUpdated(
        address indexed oracle,
        uint8 indexed category,
        uint256 alpha,
        uint256 beta
    );
    /// @notice The learned dependence between two sources changed.
    event DependenceUpdated(uint32 indexed sourceA, uint32 indexed sourceB, uint256 rho);

    error InvalidParams(string reason);
    error UnknownCategory(uint8 category);
    error UnknownSource(uint32 sourceId);
    error SourceAlreadyRegistered(address signer);
    error ZeroAddress();
    error SourceCategoryMismatch(uint32 sourceId, uint8 category);
    error OracleAlreadyRegistered(address oracle, uint8 category);
    error UnknownOracle(address oracle, uint8 category);
    error TooManyOracles(uint8 category);
    error InvalidDependence();

    /// @param admin Account receiving the admin role.
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ categories

    /// @notice Store a new parameter version for a category (creating the category on first use).
    ///         Events created afterwards use it; existing events keep their snapshot.
    /// @param category Category id (0 = flight delay, 1 = 24 h rainfall by convention).
    /// @param p The full parameter set.
    /// @return version Index of the stored version.
    function setCategory(
        uint8 category,
        CategoryParams memory p
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 version) {
        _validate(p);
        _versions[category].push(p);
        version = _versions[category].length - 1;
        emit CategoryUpdated(category, version);
    }

    /// @notice Number of parameter versions stored for a category (0 = unknown category).
    /// @param category Category id.
    /// @return Version count.
    function versionCount(uint8 category) public view returns (uint256) {
        return _versions[category].length;
    }

    /// @notice Index of the newest parameter version of a category.
    /// @param category Category id.
    /// @return Latest version index.
    function latestVersion(uint8 category) public view returns (uint256) {
        uint256 n = _versions[category].length;
        if (n == 0) revert UnknownCategory(category);
        return n - 1;
    }

    /// @notice Read one parameter version.
    /// @param category Category id.
    /// @param version Version index.
    /// @return The parameter set.
    function getParams(
        uint8 category,
        uint256 version
    ) external view returns (CategoryParams memory) {
        if (version >= _versions[category].length) revert UnknownCategory(category);
        return _versions[category][version];
    }

    // --------------------------------------------------------------------- sources

    /// @notice Register an upstream source identified by the key it signs reports with.
    /// @param signer Source signing address.
    /// @param category Category the source serves.
    /// @param name Display name.
    /// @param toolHashes Tool hashes the source may use.
    /// @return sourceId The new source id (1-based).
    function registerSource(
        address signer,
        uint8 category,
        string calldata name,
        bytes32[] calldata toolHashes
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint32 sourceId) {
        if (signer == address(0)) revert ZeroAddress();
        if (_versions[category].length == 0) revert UnknownCategory(category);
        if (sourceIdOfSigner[signer] != 0) revert SourceAlreadyRegistered(signer);
        sourceId = ++sourceCount;
        _sources[sourceId] = Source(signer, category, true, name);
        sourceIdOfSigner[signer] = sourceId;
        activeSourceCount[category] += 1;
        emit SourceRegistered(sourceId, signer, category, name);
        for (uint256 i = 0; i < toolHashes.length; i++) {
            toolHashAllowed[sourceId][toolHashes[i]] = true;
            emit ToolHashUpdated(sourceId, toolHashes[i], true);
        }
    }

    /// @notice Activate or deactivate a source.
    /// @param sourceId The source.
    /// @param active New state.
    function setSourceActive(uint32 sourceId, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Source storage s = _requireSource(sourceId);
        if (s.active != active) {
            s.active = active;
            if (active) activeSourceCount[s.category] += 1;
            else activeSourceCount[s.category] -= 1;
        }
        emit SourceUpdated(sourceId, active);
    }

    /// @notice Allow or disallow a tool hash for a source.
    /// @param sourceId The source.
    /// @param toolHash Hash of the tool name and input schema.
    /// @param allowed New state.
    function setToolHash(
        uint32 sourceId,
        bytes32 toolHash,
        bool allowed
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireSource(sourceId);
        toolHashAllowed[sourceId][toolHash] = allowed;
        emit ToolHashUpdated(sourceId, toolHash, allowed);
    }

    /// @notice Read a source.
    /// @param sourceId The source.
    /// @return signer Signing address.
    /// @return category Category served.
    /// @return active Whether it is active.
    /// @return name Display name.
    function getSource(
        uint32 sourceId
    ) external view returns (address signer, uint8 category, bool active, string memory name) {
        Source storage s = _requireSource(sourceId);
        return (s.signer, s.category, s.active, s.name);
    }

    // ---------------------------------------------------------------------- oracles

    /// @notice Register an oracle key for a category and bind it to a home source.
    /// @param oracle Oracle address.
    /// @param category Category id.
    /// @param sourceId Home source (must serve the same category).
    /// @param primary Whether the oracle sits on the round-1 committee.
    function registerOracle(
        address oracle,
        uint8 category,
        uint32 sourceId,
        bool primary
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (oracle == address(0)) revert ZeroAddress();
        uint256 n = _versions[category].length;
        if (n == 0) revert UnknownCategory(category);
        Source storage s = _requireSource(sourceId);
        if (s.category != category) revert SourceCategoryMismatch(sourceId, category);
        if (_oracles[oracle][category].registered) revert OracleAlreadyRegistered(oracle, category);
        if (_oracleList[category].length >= MAX_ORACLES_PER_CATEGORY)
            revert TooManyOracles(category);
        CategoryParams storage p = _versions[category][n - 1];
        _oracles[oracle][category] = Oracle(true, true, primary, sourceId, p.alpha0, p.beta0);
        _oracleList[category].push(oracle);
        _registrations[oracle] += 1;
        emit OracleRegistered(oracle, category, sourceId, primary);
    }

    /// @notice Change an oracle's home source, primary flag or active flag.
    /// @param oracle Oracle address.
    /// @param category Category id.
    /// @param sourceId Home source (must serve the same category).
    /// @param primary Round-1 committee flag.
    /// @param active Whether the oracle may be selected and may report.
    function updateOracle(
        address oracle,
        uint8 category,
        uint32 sourceId,
        bool primary,
        bool active
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Oracle storage o = _oracles[oracle][category];
        if (!o.registered) revert UnknownOracle(oracle, category);
        Source storage s = _requireSource(sourceId);
        if (s.category != category) revert SourceCategoryMismatch(sourceId, category);
        o.sourceId = sourceId;
        o.primary = primary;
        o.active = active;
        emit OracleUpdated(oracle, category, sourceId, primary, active);
    }

    /// @notice Read an oracle's registration for a category.
    /// @param oracle Oracle address.
    /// @param category Category id.
    /// @return registered Whether the oracle was ever registered for the category.
    /// @return active Whether it is currently active.
    /// @return primary Whether it sits on the round-1 committee.
    /// @return sourceId Its home source.
    function getOracle(
        address oracle,
        uint8 category
    ) external view returns (bool registered, bool active, bool primary, uint32 sourceId) {
        Oracle storage o = _oracles[oracle][category];
        return (o.registered, o.active, o.primary, o.sourceId);
    }

    /// @notice Whether the address is registered as an oracle in any category.
    /// @param account Address to test.
    /// @return True if registered in at least one category.
    function isOracle(address account) external view returns (bool) {
        return _registrations[account] > 0;
    }

    /// @notice Number of oracles registered for a category (active or not).
    /// @param category Category id.
    /// @return Oracle count.
    function oracleCount(uint8 category) external view returns (uint256) {
        return _oracleList[category].length;
    }

    /// @notice Oracle at position `index` of a category's list.
    /// @param category Category id.
    /// @param index Position.
    /// @return The oracle address.
    function oracleAt(uint8 category, uint256 index) external view returns (address) {
        return _oracleList[category][index];
    }

    /// @notice Active oracles flagged primary for a category, in registration order. These form
    ///         the round-1 committee.
    /// @param category Category id.
    /// @return list The primary oracles.
    function activePrimaryOracles(uint8 category) external view returns (address[] memory list) {
        address[] storage all = _oracleList[category];
        uint256 count;
        for (uint256 i = 0; i < all.length; i++) {
            Oracle storage o = _oracles[all[i]][category];
            if (o.active && o.primary) count++;
        }
        list = new address[](count);
        uint256 k;
        for (uint256 i = 0; i < all.length; i++) {
            Oracle storage o = _oracles[all[i]][category];
            if (o.active && o.primary) list[k++] = all[i];
        }
    }

    /// @notice Reputation parameters of an oracle in a category.
    /// @param oracle Oracle address.
    /// @param category Category id.
    /// @return alpha Successes (WAD).
    /// @return beta Failures (WAD).
    function reputation(
        address oracle,
        uint8 category
    ) external view returns (uint256 alpha, uint256 beta) {
        Oracle storage o = _oracles[oracle][category];
        return (o.alpha, o.beta);
    }

    /// @notice Reputation as a probability, alpha / (alpha + beta), in WAD.
    /// @param oracle Oracle address.
    /// @param category Category id.
    /// @return Reputation weight R (WAD); 0 for an unknown oracle.
    function reputationWeight(address oracle, uint8 category) external view returns (uint256) {
        Oracle storage o = _oracles[oracle][category];
        uint256 total = o.alpha + o.beta;
        if (total == 0) return 0;
        return (o.alpha * WAD) / total;
    }

    /// @notice Overwrite an oracle's reputation (called by the engine after finalization).
    /// @param oracle Oracle address.
    /// @param category Category id.
    /// @param alpha New alpha (WAD).
    /// @param beta New beta (WAD).
    function setReputation(
        address oracle,
        uint8 category,
        uint256 alpha,
        uint256 beta
    ) external onlyRole(ENGINE_ROLE) {
        Oracle storage o = _oracles[oracle][category];
        if (!o.registered) revert UnknownOracle(oracle, category);
        o.alpha = alpha;
        o.beta = beta;
        emit ReputationUpdated(oracle, category, alpha, beta);
    }

    // ------------------------------------------------------------------ dependence

    /// @notice Dependence between two sources. Identical sources are fully dependent (1.0); a pair
    ///         never learned about returns `fallbackRho`.
    /// @param a First source.
    /// @param b Second source.
    /// @param fallbackRho Value returned when nothing was learned (the category prior).
    /// @return rho Dependence in WAD.
    function dependence(
        uint32 a,
        uint32 b,
        uint256 fallbackRho
    ) external view returns (uint256 rho) {
        if (a == b) return WAD;
        rho = _rho[_pairKey(a, b)];
        if (rho == 0) rho = fallbackRho;
    }

    /// @notice Store a learned dependence between two distinct sources.
    /// @param a First source.
    /// @param b Second source.
    /// @param rho New dependence (WAD, 1..1.0).
    function setDependence(uint32 a, uint32 b, uint256 rho) external onlyRole(ENGINE_ROLE) {
        if (a == b || rho == 0 || rho > WAD) revert InvalidDependence();
        _rho[_pairKey(a, b)] = rho;
        emit DependenceUpdated(a < b ? a : b, a < b ? b : a, rho);
    }

    // -------------------------------------------------------------------- internals

    function _pairKey(uint32 a, uint32 b) private pure returns (bytes32) {
        return a < b ? bytes32((uint256(a) << 32) | b) : bytes32((uint256(b) << 32) | a);
    }

    function _requireSource(uint32 sourceId) private view returns (Source storage s) {
        s = _sources[sourceId];
        if (s.signer == address(0)) revert UnknownSource(sourceId);
    }

    function _validate(CategoryParams memory p) private pure {
        if (p.bucketCount == 0) revert InvalidParams("bucketCount");
        if (p.bucketWidth == 0) revert InvalidParams("bucketWidth");
        if (p.kMax == 0 || p.kRound == 0) revert InvalidParams("rounds");
        if (p.maxReportsPerEvent == 0 || p.maxReportsPerEvent > 16) {
            revert InvalidParams("maxReportsPerEvent");
        }
        if (p.s == 0) revert InvalidParams("s");
        if (p.delta == 0) revert InvalidParams("delta");
        if (p.nMin <= WAD) revert InvalidParams("nMin");
        if (p.rho0 > WAD) revert InvalidParams("rho0");
        if (p.alpha0 == 0 || p.beta0 == 0) revert InvalidParams("initialReputation");
        if (p.gamma == 0 || p.gamma > WAD) revert InvalidParams("gamma");
        if (p.mu > WAD) revert InvalidParams("mu");
        if (p.eta == 0 || p.eta > WAD) revert InvalidParams("eta");
        if (p.zByRound.length < p.kMax) revert InvalidParams("zByRound");
        uint256 n = p.curveTheta.length;
        if (n < 2 || n != p.curveProb.length) revert InvalidParams("curve");
        for (uint256 i = 0; i < n; i++) {
            if (p.curveProb[i] > WAD) revert InvalidParams("curve");
            if (i > 0) {
                if (p.curveTheta[i] <= p.curveTheta[i - 1]) revert InvalidParams("curve");
                if (p.curveProb[i] > p.curveProb[i - 1]) revert InvalidParams("curve");
            }
        }
    }
}
