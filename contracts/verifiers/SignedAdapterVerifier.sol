// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IOriginVerifier} from "./IOriginVerifier.sol";
import {TIESRegistry} from "../core/TIESRegistry.sol";

/// @title SignedAdapterVerifier
/// @notice Derives a report's source id from the signature of a registered source adapter.
/// @dev The signed digest is keccak256(abi.encode(chainId, engine, eventId, value, ts, toolHash,
///      argsHash, responseHash)) wrapped as an EIP-191 personal message. It binds the report to
///      this chain, this engine and this event, so it cannot be replayed elsewhere.
contract SignedAdapterVerifier is IOriginVerifier {
    /// @notice Oldest report timestamp accepted, measured back from the observation end.
    uint256 public constant MAX_REPORT_AGE = 1 days;

    TIESRegistry public immutable registry;

    /// @notice The signature is malformed or does not recover to an address.
    error InvalidSignature();
    /// @notice The recovered signer is not a registered source.
    error UnknownSigner(address signer);
    /// @notice The source is deactivated.
    error SourceInactive(uint32 sourceId);
    /// @notice The source serves a different category than the event.
    error SourceWrongCategory(uint32 sourceId, uint8 expected);
    /// @notice The tool hash is not on the source's allowlist.
    error ToolNotAllowed(uint32 sourceId, bytes32 toolHash);
    /// @notice The report timestamp is older than allowed.
    error StaleReport(uint256 ts, uint256 earliest);
    /// @notice The report timestamp is in the future.
    error FutureReport(uint256 ts, uint256 nowTs);

    /// @param registry_ The registry holding sources and tool allowlists.
    constructor(TIESRegistry registry_) {
        registry = registry_;
    }

    /// @notice Digest a source signs for a report (before the EIP-191 prefix).
    /// @param engine The settlement engine address the report is bound to.
    /// @param eventId The insured event.
    /// @param r The report.
    /// @return The digest.
    function digest(
        address engine,
        uint256 eventId,
        SourceReport calldata r
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    block.chainid,
                    engine,
                    eventId,
                    r.value,
                    r.ts,
                    r.toolHash,
                    r.argsHash,
                    r.responseHash
                )
            );
    }

    /// @inheritdoc IOriginVerifier
    function verify(
        uint256 eventId,
        uint8 category,
        uint256 observationEnd,
        SourceReport calldata r
    ) external view returns (uint32 sourceId) {
        bytes32 signed = MessageHashUtils.toEthSignedMessageHash(digest(msg.sender, eventId, r));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(signed, r.sourceSig);
        if (err != ECDSA.RecoverError.NoError) revert InvalidSignature();

        sourceId = registry.sourceIdOfSigner(signer);
        if (sourceId == 0) revert UnknownSigner(signer);
        (, uint8 sourceCategory, bool active, ) = registry.getSource(sourceId);
        if (!active) revert SourceInactive(sourceId);
        if (sourceCategory != category) revert SourceWrongCategory(sourceId, category);
        if (!registry.toolHashAllowed(sourceId, r.toolHash)) {
            revert ToolNotAllowed(sourceId, r.toolHash);
        }

        if (r.ts > block.timestamp) revert FutureReport(r.ts, block.timestamp);
        uint256 earliest = observationEnd > MAX_REPORT_AGE ? observationEnd - MAX_REPORT_AGE : 0;
        if (r.ts < earliest) revert StaleReport(r.ts, earliest);
    }
}
