// CUA-1.75 peer-identity probe: the native half of "connected socket → kernel-derived peer
// identity → native code-signing verification → exact admitted Helper identity".
//
// One process, one question: "who is on the other end of THIS socket, and what did it exec?"
// The accepted socket arrives as fd 3 (inherited from the host via child_process stdio
// passthrough — measured; no SCM_RIGHTS needed), the pinned Helper requirement arrives as
// `--requirement`. Output is one JSON line on stdout.
//
// Exit 0 = a complete report (the identity section may still say `verified: false` — that is
// an answer, not a failure). Exit 1 = the report could not be produced at all (no kernel
// binding, or unreadable exec args); the host treats that as `peer_identity_unavailable` and
// refuses admission (fail closed).
//
// Authority for every step: specs/computer-use.md, "CUA-1.75". Measured facts behind the
// mechanism choices: `LOCAL_PEERTOKEN` works on accepted AF_UNIX stream sockets and its pid
// word agrees with `LOCAL_PEERPID`; `kSecGuestAttributeAudit` binds resolution to the process
// INSTANCE (a bumped pidversion fails with -67065, so a recycled pid number cannot resolve);
// a dead peer yields ENOTCONN from both getsockopts (a stale connection cannot be bound);
// `KERN_PROCARGS2` returns the peer's exec argv with argument boundaries intact.

import Darwin
import Foundation
import Security

/// Mirror of main.swift's `Args`, compiled against the shared `CodeIdentity.swift` so the two
/// helper/probe builds stay one verification source. Probe flags are parsed by hand below;
/// this shim exists only because `resolveHelperIdentityPolicy(args:)` names the type.
struct Args {
    let raw: [String]
    func string(_ name: String) -> String? {
        guard let i = raw.firstIndex(of: "--\(name)"), i + 1 < raw.count else { return nil }
        return raw[i + 1]
    }
    func int(_ name: String) -> Int? { string(name).flatMap(Int.init) }
    func has(_ name: String) -> Bool { raw.contains("--\(name)") }
}

// MARK: - Output

func emitAndExit(_ object: [String: Any], code: Int32) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(code)
}

func fail(_ code: String, _ message: String) -> Never {
    emitAndExit(
        ["ok": false, "error": ["code": code, "message": message]], code: 1)
}

// MARK: - Exec-time argv (launch-contract evidence)

/// The peer's exec argv via `KERN_PROCARGS2`: `argc`, then the exec path, NUL padding, then
/// `argc` NUL-separated argument strings. The SDK's proc_info.h has no PROC_PIDARGSINFO
/// (measured), so this is the argv source; note it reads the process's argv memory — a
/// process can rewrite that (measured with `process.title`), which is exactly why the policy
/// only trusts this for a peer that already passed audit-token binding AND code-signing
/// verification of the approved image (spec, "What the launch-contract check is, and is not").
func execArgs(of pid: pid_t) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buf = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 0 else { return nil }
    let argc = Int(buf.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: Int32.self) })
    guard argc > 0 else { return nil }
    var i = MemoryLayout<Int32>.size
    while i < size, buf[i] != 0 { i += 1 }  // skip the exec path
    while i < size, buf[i] == 0 { i += 1 }  // skip its NUL padding
    var argv: [String] = []
    for _ in 0..<argc {
        var bytes: [UInt8] = []
        while i < size, buf[i] != 0 {
            bytes.append(buf[i])
            i += 1
        }
        if i >= size, buf[i - 1] != 0 { return nil }  // truncated argument block
        i += 1
        argv.append(String(decoding: bytes, as: UTF8.self))
    }
    return argv.isEmpty ? nil : argv
}

// MARK: - Kernel peer binding

/// The audit-token word order measured on macOS 27 for `audit_token_t`:
/// `[auid, euid, egid, ruid, rgid, pid, asid, pidversion]`. The reading is self-verifying:
/// word 5 must equal `LOCAL_PEERPID` and word 3 must equal `LOCAL_PEERCRED`'s uid, else the
/// probe fails closed rather than trusting an assumed layout.
private let tokenPidWord = 5
private let tokenPidversionWord = 7

func auditWords(_ token: audit_token_t) -> [UInt32] {
    withUnsafeBytes(of: token) { raw in
        stride(from: 0, to: raw.count, by: 4).map {
            raw.loadUnaligned(fromByteOffset: $0, as: UInt32.self)
        }
    }
}

let socketFd: Int32 = {
    let raw = Array(CommandLine.arguments.dropFirst())
    if let i = raw.firstIndex(of: "--socket-fd"), i + 1 < raw.count, let fd = Int32(raw[i + 1]) {
        return fd
    }
    return 3
}()

let requirement: String = {
    let raw = Array(CommandLine.arguments.dropFirst())
    guard let i = raw.firstIndex(of: "--requirement"), i + 1 < raw.count else {
        fail("probe_usage", "the probe requires --requirement <DR>")
    }
    let value = raw[i + 1]
    guard !value.isEmpty else { fail("probe_usage", "the probe requires a non-empty requirement") }
    return value
}()

var peerToken = audit_token_t()
var tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
guard getsockopt(socketFd, SOL_LOCAL, LOCAL_PEERTOKEN, &peerToken, &tokenLength) == 0 else {
    // Measured: a peer that already exited leaves the socket ENOTCONN here. A connection that
    // cannot name its peer instance is refused — that is the stale-peer rule, fail closed.
    fail("peer_token_unavailable", "the connected socket yields no peer audit token (errno \(errno))")
}
let words = auditWords(peerToken)
guard words.count == 8 else { fail("peer_token_unavailable", "unexpected audit token shape") }

var peerPid: pid_t = 0
var pidLength = socklen_t(MemoryLayout<pid_t>.size)
let peerPidStatus = getsockopt(socketFd, SOL_LOCAL, LOCAL_PEERPID, &peerPid, &pidLength)

var peerCred = xucred()
var credLength = socklen_t(MemoryLayout<xucred>.size)
let peerCredStatus = getsockopt(socketFd, SOL_LOCAL, LOCAL_PEERCRED, &peerCred, &credLength)

let boundPid = pid_t(words[tokenPidWord])
guard boundPid > 0 else { fail("peer_token_unavailable", "the audit token names no process") }
guard peerPidStatus == 0, peerPid == boundPid else {
    // The two kernel sources must agree on the peer; a disagreement is not a guess we make.
    fail("peer_token_unavailable", "LOCAL_PEERPID does not agree with the audit token")
}
guard peerCredStatus == 0, peerCred.cr_uid == uid_t(words[1]) else {
    // Same discipline for the credential source: LOCAL_PEERCRED must agree with the token's
    // euid, or the report is refused outright (defence in depth; adversarial-review finding).
    fail("peer_token_unavailable", "LOCAL_PEERCRED does not agree with the audit token")
}

// MARK: - Code-signing verification of the exact peer instance

let tokenData = withUnsafeBytes(of: peerToken) { Data($0) }
var code: SecCode?
let copyStatus = SecCodeCopyGuestWithAttributes(
    nil, [kSecGuestAttributeAudit: tokenData] as CFDictionary, [], &code)
guard copyStatus == errSecSuccess, let code else {
    // pid + pidversion resolution: a dead or recycled instance lands here (a bumped pidversion
    // is measured to fail -67065) and is refused, never resolved by pid number alone.
    fail(
        "peer_unresolved",
        "the peer's process instance could not be resolved (status \(copyStatus))")
}

// The full `describeCode` chain (shared source with the Helper's CodeIdentity.swift):
// dynamic validity, fresh on-disk strict/all-architectures re-validation, bundle-level
// nested-code validation, signing information — against the host-pinned requirement.
let identity = describeCode(
    code, pid: Int(boundPid), expectedIdentifier: "",
    expectedRequirement: requirement, expectationSource: "host-pinned")

// MARK: - Report

guard let argv = execArgs(of: boundPid) else {
    fail("peer_args_unavailable", "the bound process's exec arguments are unreadable")
}

emitAndExit(
    [
        "ok": true,
        "binding": [
            "pid": Int(boundPid),
            "pidversion": Int(words[tokenPidversionWord]),
            "auid": Int(words[0]),
            "euid": Int(words[1]),
            "egid": Int(words[2]),
            "ruid": Int(words[3]),
            "rgid": Int(words[4]),
            "asid": Int(words[6]),
            "peerpid_agrees": peerPidStatus == 0 && peerPid == boundPid,
            "peercred_agrees": peerCredStatus == 0 && peerCred.cr_uid == uid_t(words[1]),
        ],
        "identity": identity.json,
        "peer_args": argv,
    ], code: 0)
