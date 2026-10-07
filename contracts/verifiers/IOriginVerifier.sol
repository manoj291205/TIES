// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IOriginVerifier
/// @notice Turns a report into the id of the upstream source that produced it, based on a proof
///         the contract can check itself. The oracle's own claim about its source is never used.
interface IOriginVerifier {
    /// @notice One report as revealed by an oracle.
    struct SourceReport {
        uint256 value; // milli-units
        uint256 ts; // timestamp the source observed the value
        bytes32 toolHash; // hash of the tool name and input schema
        bytes32 argsHash; // hash of the tool arguments
        bytes32 responseHash; // hash of the raw response
        bytes sourceSig; // EIP-191 signature by the source's registered key
    }

    /// @notice Verify a report for an event and return the source it provably came from. The
    ///         calling contract is treated as the settlement engine the signature is bound to.
    /// @param eventId The insured event.
    /// @param category The event's category.
    /// @param observationEnd End of the event's observation window.
    /// @param report The report to verify.
    /// @return sourceId The id of the verified source.
    function verify(
        uint256 eventId,
        uint8 category,
        uint256 observationEnd,
        SourceReport calldata report
    ) external view returns (uint32 sourceId);
}
