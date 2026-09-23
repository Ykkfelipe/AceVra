// CUA-1 code-identity verification, for the helper and for whoever connects to it.
//
// Why this exists (measured, not assumed — see specs/computer-use.md "Security implications"):
// a TCC grant survives edits to the signed image. Changing one byte inside `__text`, changing
// one byte inside `__cstring` and appending bytes past the signed code limit all left both
// grants intact while `codesign --verify` failed. Holding the grant therefore proves only that
// the *requirement* was satisfied once; it says nothing about the image on disk and nothing
// about which process is on the other end of a socket. The only sound integrity decision is an
// explicit code-signature validation, which is what this file adds to the production path.
//
// Two identities are resolved, and neither is a self-reported string:
//
//   * self — the running helper. `SecCodeCopySelf` names the code object the kernel has for
//     this process, `SecCodeCheckValidity` proves it still satisfies its seal (so a tampered
//     image is caught), and `SecCodeCopySigningInformation` yields the identifier/team/cdhash
//     *from the signature*. `grant_owner` is reported from that, never from
//     `Bundle.main.bundleIdentifier` (an Info.plist claim the process makes about itself).
//
//   * peer — the process that connected to the broker socket. Its pid comes from
//     `LOCAL_PEERPID`, which only the kernel can supply for a connected socket, and is then
//     resolved to a SecCode and validated the same way. A pid alone is spoofable and is never
//     treated as an identity; the signature behind it is.
//
// Scope note: the helper always *reports* the caller's verified identity, and enforces an
// expected caller identity when one is configured (`--require-peer-identifier` /
// ZCODE_CUA_REQUIRED_PEER_ID). CUA-1 does not configure one, because the component that will
// launch the helper in production (the desktop host's `buildHelperOpenArgs`) is still a
// fail-closed stub in this fork, so its identity is not yet knowable here. That gap, and the
// same-uid socket-substitution gap it leaves, are named in the spec rather than papered over.

import Foundation
import Security

// MARK: - Report

/// One validated code identity. Every field is derived from the signature.
struct CodeIdentityReport {
    var verified: Bool
    var identifier: String
    var teamIdentifier: String
    var cdHash: String
    var requirement: String
    var adHoc: Bool
    var pid: Int
    /// The identifier this report was checked against, and where that expectation came from.
    var expectedIdentifier: String
    var expectationSource: String
    /// Empty when `verified`; otherwise why the check failed.
    var reason: String

    var json: [String: Any] {
        [
            "verified": verified,
            "identifier": identifier,
            "team_id": teamIdentifier,
            "cd_hash": cdHash,
            "requirement": requirement,
            "ad_hoc": adHoc,
            "pid": pid,
            "expected_identifier": expectedIdentifier,
            "expectation_source": expectationSource,
            "reason": reason,
        ]
    }

    static func failed(_ reason: String, pid: Int = 0, expected: String = "",
                       source: String = "") -> CodeIdentityReport {
        CodeIdentityReport(
            verified: false, identifier: "", teamIdentifier: "", cdHash: "",
            requirement: "", adHoc: false, pid: pid,
            expectedIdentifier: expected, expectationSource: source, reason: reason)
    }
}

// MARK: - Policy

/// Which identities the helper is willing to serve, as configured by its launcher.
struct HelperIdentityPolicy {
    /// Expected identifier of *this* helper. Empty means "accept whatever the signature says",
    /// i.e. self-consistency only — the external expectation belongs to the caller, which holds
    /// the contract constant. See the client-side check in packages/zcode-cua/broker.js.
    var expectedSelfIdentifier: String
    /// Expected identifier of the process allowed to call the broker socket. Empty means
    /// "report the caller, do not enforce"; a non-empty value is enforced on every request.
    var requiredPeerIdentifier: String
    /// Refuse to serve when the caller's signature does not validate at all.
    var requireSignedPeer: Bool

    static let `default` = HelperIdentityPolicy(
        expectedSelfIdentifier: "", requiredPeerIdentifier: "", requireSignedPeer: false)
}

/// Set once from main.swift before the socket server starts. A `var` global with an initializer
/// is safe to read from any file: the first access initializes it, and main.swift assigns before
/// dispatch begins.
var cuaIdentityPolicy = HelperIdentityPolicy.default

func resolveHelperIdentityPolicy(args: Args) -> HelperIdentityPolicy {
    let environment = ProcessInfo.processInfo.environment
    func value(_ flag: String, _ envKey: String) -> String {
        if let fromFlag = args.string(flag)?.trimmingCharacters(in: .whitespaces), !fromFlag.isEmpty {
            return fromFlag
        }
        if let fromEnv = environment[envKey]?.trimmingCharacters(in: .whitespaces), !fromEnv.isEmpty {
            return fromEnv
        }
        return ""
    }
    return HelperIdentityPolicy(
        expectedSelfIdentifier: value("expected-identifier", "ZCODE_CUA_EXPECTED_HELPER_ID"),
        requiredPeerIdentifier: value("require-peer-identifier", "ZCODE_CUA_REQUIRED_PEER_ID"),
        requireSignedPeer: args.has("require-signed-peer")
            || environment["ZCODE_CUA_REQUIRE_SIGNED_PEER"] == "1")
}

// MARK: - Validation primitives

/// The two validations are split because the API splits them (measured on macOS 27): the
/// dynamic `SecCodeCheckValidity` rejects `kSecCSCheckAllArchitectures` with
/// `errSecCSInvalidFlags` (-67070), while `SecStaticCodeCheckValidity` accepts it. Running both
/// is what makes the check equivalent to `codesign --verify --strict --all-architectures`:
/// the static call proves the on-disk image is unmodified in every slice, and the dynamic call
/// proves the *running* process is still the code the signature describes.
private let strictDynamicFlags = SecCSFlags(rawValue: UInt32(kSecCSStrictValidate))
private let strictStaticFlags = SecCSFlags(
    rawValue: UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSStrictValidate))

private func signingInformationFlags() -> SecCSFlags {
    SecCSFlags(rawValue: UInt32(kSecCSSigningInformation) | UInt32(kSecCSRequirementInformation))
}

/// `kSecCodeSignatureAdhoc` is a `SecCodeSignatureFlags` member and is not imported into Swift
/// alongside the `kSecCodeInfo*` dictionary keys, so the documented value is spelled out here.
/// It matters because an ad-hoc grant dies on the next rebuild (measured in the identity
/// foundation), so a caller may want to refuse one.
private let secCodeSignatureAdhoc: UInt32 = 0x2

private func hexString(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

/// Requirement text meant to be a human-readable record, not a check input.
private func requirementText(_ information: [String: Any]) -> String {
    guard let raw = information[kSecCodeInfoDesignatedRequirement as String],
        CFGetTypeID(raw as CFTypeRef) == SecRequirementGetTypeID()
    else { return "" }
    var text: CFString?
    let status = SecRequirementCopyString(raw as! SecRequirement, [], &text)
    guard status == errSecSuccess, let text else { return "" }
    return text as String
}

/// Validate one code object and describe it from its signature.
///
/// Three checks run, in this order, and each was added because a measurement showed the previous
/// set was insufficient:
///
///  1. `SecCodeCheckValidity` on the dynamic code — the running process satisfies the requirement.
///  2. `SecStaticCodeCheckValidity` on a **freshly opened on-disk image** with strict + all-architecture
///     flags — the check that actually catches an in-place edit. Opening the static code *from the
///     running process* (`SecCodeCopyStaticCode`) is not enough: a measured `__text` tamper left
///     that check passing, because the process was validated when it was executed. Re-opening the
///     image from its path re-hashes every slice, which is what caught the same tamper
///     (`errSecCSSignatureFailed`, -67061).
///  3. `SecCodeCopySigningInformation` on that validated on-disk image, so the identifier reported
///     downstream comes from the signature that was just verified rather than from the process's
///     own description of itself.
///
/// The order matters: a report with `verified: false` never carries a trusted identifier.
func describeCode(
    _ code: SecCode, pid: Int, expectedIdentifier: String, expectationSource: String
) -> CodeIdentityReport {
    // A configured expectation is checked with the platform's own requirement language, so it is
    // the same mechanism `codesign -r-` prints rather than a string comparison we invented.
    var requirement: SecRequirement?
    if !expectedIdentifier.isEmpty {
        var raw: SecRequirement?
        let requirementText = "identifier \"\(expectedIdentifier)\""
        let status = SecRequirementCreateWithString(
            requirementText as CFString, [], &raw)
        if status != errSecSuccess {
            return CodeIdentityReport.failed(
                "expected identifier \(expectedIdentifier) is not a valid code requirement",
                pid: pid, expected: expectedIdentifier, source: expectationSource)
        }
        requirement = raw
    }

    let validity = SecCodeCheckValidity(code, strictDynamicFlags, requirement)
    if validity != errSecSuccess {
        return CodeIdentityReport.failed(
            requirement == nil
                ? "SecCodeCheckValidity failed (status \(validity)); the running image is not "
                    + "the code its signature describes"
                : "code does not satisfy the \(expectationSource) expected identifier "
                    + "\"\(expectedIdentifier)\" (status \(validity))",
            pid: pid, expected: expectedIdentifier, source: expectationSource)
    }

    // Where the code was loaded from, then re-open it as a static code object. `SecCodeCopyPath`
    // answers for the running code object, so this is the image the kernel mapped, not a path the
    // caller supplied.
    var runningStaticCode: SecStaticCode?
    let staticStatus = SecCodeCopyStaticCode(code, [], &runningStaticCode)
    guard staticStatus == errSecSuccess, let runningStaticCode else {
        return CodeIdentityReport.failed(
            "code could not be resolved to a static image (status \(staticStatus))", pid: pid,
            expected: expectedIdentifier, source: expectationSource)
    }
    var pathURL: CFURL?
    guard SecCodeCopyPath(runningStaticCode, [], &pathURL) == errSecSuccess, let pathURL else {
        return CodeIdentityReport.failed(
            "code has no on-disk image to validate", pid: pid,
            expected: expectedIdentifier, source: expectationSource)
    }

    var onDiskCode: SecStaticCode?
    let openStatus = SecStaticCodeCreateWithPath(pathURL, [], &onDiskCode)
    guard openStatus == errSecSuccess, let onDiskCode else {
        return CodeIdentityReport.failed(
            "on-disk image could not be opened for validation (status \(openStatus))", pid: pid,
            expected: expectedIdentifier, source: expectationSource)
    }
    let onDiskValidity = SecStaticCodeCheckValidity(onDiskCode, strictStaticFlags, requirement)
    if onDiskValidity != errSecSuccess {
        return CodeIdentityReport.failed(
            "SecStaticCodeCheckValidity failed (status \(onDiskValidity)); the image on disk no "
                + "longer matches its signature (all architectures checked)",
            pid: pid, expected: expectedIdentifier, source: expectationSource)
    }

    var informationRaw: CFDictionary?
    guard SecCodeCopySigningInformation(onDiskCode, signingInformationFlags(), &informationRaw)
        == errSecSuccess,
        let information = informationRaw as? [String: Any]
    else {
        return CodeIdentityReport.failed(
            "code has no readable signature information", pid: pid,
            expected: expectedIdentifier, source: expectationSource)
    }

    let identifier = information[kSecCodeInfoIdentifier as String] as? String ?? ""
    guard !identifier.isEmpty else {
        return CodeIdentityReport.failed(
            "code carries no signing identifier", pid: pid,
            expected: expectedIdentifier, source: expectationSource)
    }

    let signatureFlags =
        (information[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    let adHoc = (signatureFlags & secCodeSignatureAdhoc) != 0
    let unique = information[kSecCodeInfoUnique as String] as? Data

    return CodeIdentityReport(
        verified: true,
        identifier: identifier,
        teamIdentifier: information[kSecCodeInfoTeamIdentifier as String] as? String ?? "",
        cdHash: unique.map(hexString) ?? "",
        requirement: requirementText(information),
        adHoc: adHoc,
        pid: pid,
        expectedIdentifier: expectedIdentifier,
        expectationSource: expectationSource,
        reason: "")
}

// MARK: - Self

/// The running helper's own verified identity. Computed once: the loaded image cannot change,
/// and re-validating on every request would spend a signature check per call for nothing.
let helperSelfIdentity: CodeIdentityReport = {
    let policy = cuaIdentityPolicy
    var code: SecCode?
    let status = SecCodeCopySelf([], &code)
    guard status == errSecSuccess, let code else {
        return CodeIdentityReport.failed(
            "SecCodeCopySelf failed (status \(status))", pid: Int(getpid()),
            expected: policy.expectedSelfIdentifier,
            source: policy.expectedSelfIdentifier.isEmpty ? "signature" : "configured")
    }
    let source = policy.expectedSelfIdentifier.isEmpty ? "signature" : "configured"
    return describeCode(
        code, pid: Int(getpid()), expectedIdentifier: policy.expectedSelfIdentifier,
        expectationSource: source)
}()

/// A `list_apps`-sized short form for result envelopes. The full report (including the
/// designated requirement) is carried by `permission_status`, which is where a caller looks
/// when it needs to explain *why* the helper is trusted.
func shortIdentityJSON(_ report: CodeIdentityReport) -> [String: Any] {
    [
        "verified": report.verified,
        "identifier": report.identifier,
        "cd_hash": report.cdHash,
        "ad_hoc": report.adHoc,
        "pid": report.pid,
        "reason": report.reason,
    ]
}

// MARK: - Peer

/// The identity of the process on the other end of a connected socket.
///
/// `LOCAL_PEERPID` is answered by the kernel for the *connected* socket, so the pid cannot be
/// chosen by the caller. It is then resolved to a code object and validated exactly like the
/// helper's own identity; a caller without a valid signature is reported as unverified rather
/// than as some default identity.
func peerCodeIdentity(_ fd: Int32) -> CodeIdentityReport {
    let policy = cuaIdentityPolicy
    var pid: pid_t = 0
    var length = socklen_t(MemoryLayout<pid_t>.size)
    let pidStatus = getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length)
    guard pidStatus == 0, pid > 0 else {
        return CodeIdentityReport.failed(
            "LOCAL_PEERPID unavailable for this socket", expected: policy.requiredPeerIdentifier,
            source: policy.requiredPeerIdentifier.isEmpty ? "none" : "configured")
    }

    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: pid] as CFDictionary
    let copyStatus = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
    guard copyStatus == errSecSuccess, let code else {
        return CodeIdentityReport.failed(
            "the caller's process could not be resolved to a code object (status \(copyStatus))",
            pid: Int(pid), expected: policy.requiredPeerIdentifier,
            source: policy.requiredPeerIdentifier.isEmpty ? "none" : "configured")
    }
    return describeCode(
        code, pid: Int(pid), expectedIdentifier: policy.requiredPeerIdentifier,
        expectationSource: policy.requiredPeerIdentifier.isEmpty ? "none" : "configured")
}

/// Whether a request from this peer may be honoured. Reporting is always allowed; enforcement
/// only exists when the launcher named the identity it expects.
func peerIsAuthorized(_ report: CodeIdentityReport) -> Bool {
    if cuaIdentityPolicy.requireSignedPeer, !report.verified || report.adHoc { return false }
    if !cuaIdentityPolicy.requiredPeerIdentifier.isEmpty, !report.verified { return false }
    return true
}
