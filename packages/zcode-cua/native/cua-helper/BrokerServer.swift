// Broker socket server: the helper side of the contract declared in packages/zcode-cua/broker.d.ts.
//
// Wire format (also written down in packages/zcode-cua/specs/computer-use.md, because the
// contract ships as a fail-closed placeholder and CUA-1 defines the bytes):
//
//   request   { "id"?: string|null, "method": string, "params"?: object }   one JSON object per line
//   success   { "ok": true,  "result": object, "id"?: echoed }
//   failure   { "ok": false, "error": { "message": string, "code": string }, "id"?: echoed }
//
// The nested failure shape is not invented here: `errorResponse` in packages/zcode-cua/broker.js
// already returns it, and CUA-1 fills the transport around that existing choice rather than
// rewriting it.
//
// The server is single-client and serial. Observation is low-rate, and a burst-parallel design
// would buy nothing while making the "one owner of the socket" rule harder to keep.
//
// Identity: a socket path is not an identity. Anyone who can write into the runtime data root
// can bind that path, so possession of the socket proves nothing. Every result therefore carries
// the helper's verified code identity, computed from its signature by `CodeIdentity.swift`, and
// the helper refuses to answer at all when that check fails. The caller is resolved the same way
// (LOCAL_PEERPID -> SecCode) and reported; it is enforced when the launcher configured an
// expected caller identity. See the spec's "Security implications" for what that does and does
// not cover in CUA-1.

import Darwin
import Foundation

// MARK: - Responses

func brokerOk(_ result: [String: Any], id: Any?) -> [String: Any] {
    var response: [String: Any] = ["ok": true, "result": result]
    if let id, !(id is NSNull) { response["id"] = id }
    return response
}

func brokerFail(_ message: String, code: String, id: Any?) -> [String: Any] {
    var response: [String: Any] = ["ok": false, "error": ["message": message, "code": code]]
    if let id, !(id is NSNull) { response["id"] = id }
    return response
}

func brokerSerialize(_ object: [String: Any]) -> Data {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data()
    return data
}

// MARK: - Dispatch

/// Route one request. The read-only set is enforced here, which is what keeps every mutating
/// tool fail-closed: a name that is not in `observeOnlyBrokerMethods` never reaches an actuator,
/// because in CUA-1 there is no actuator to reach.
///
/// Two identity gates run before any method does:
///  1. the helper's own verified identity. A helper whose signed image no longer validates
///     (or which is not the identity its launcher expected) refuses every request rather than
///     answering with observations an unverified binary produced;
///  2. the caller's identity, when the launcher configured one. The peer report is always
///     attached so a refusal can name who asked.
func brokerDispatch(
    _ request: [String: Any], peer: CodeIdentityReport? = nil
) -> [String: Any] {
    let identity = helperSelfIdentity
    if !identity.verified {
        return brokerFail(
            "helper identity is not verified: \(identity.reason)", code: "helper_identity_unverified",
            id: request["id"])
    }
    if let peer, !peerIsAuthorized(peer) {
        return brokerFail(
            "caller identity is not authorized: \(peer.reason)", code: "peer_not_authorized",
            id: request["id"])
    }
    guard let method = request["method"] as? String else {
        return brokerFail("request has no method", code: "bad_request", id: request["id"])
    }
    guard observeOnlyBrokerMethods.contains(method) else {
        return brokerFail(
            "method '\(method)' is not available in CUA-1 (observe-only)", code: "not_authorized",
            id: request["id"])
    }
    let params = request["params"] as? [String: Any] ?? [:]
    switch method {
    case "permission_status":
        return brokerOk(permissionStatusResult(peer: peer), id: request["id"])
    case "list_apps":
        return brokerOk(listAppsResult(), id: request["id"])
    case "list_windows":
        return brokerOk(listWindowsResult(params: params), id: request["id"])
    case "observe":
        guard params["pid"] is NSNumber else {
            return brokerFail("observe requires an integer pid", code: "bad_request",
                              id: request["id"])
        }
        // A refused observation is a successful call carrying `effect: "refused"`, not a
        // transport error: the caller asked for an observation and got an honest answer.
        return brokerOk(observeResult(params: params), id: request["id"])
    default:
        return brokerFail("unreachable", code: "internal", id: request["id"])
    }
}

// MARK: - Server

/// Serve until the socket is closed or the helper has been idle for `idleMs`.
func runBrokerSocketServer(socketPath: String, idleMs: Int) -> Never {
    // A client that disconnects mid-write must not kill the helper.
    signal(SIGPIPE, SIG_IGN)

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
        FileHandle.standardError.write("broker: socket() failed\n".data(using: .utf8)!)
        exit(70)
    }
    unlink(socketPath)

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
        FileHandle.standardError.write("broker: socket path too long\n".data(using: .utf8)!)
        exit(70)
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count + 1) { destination in
            for (offset, byte) in pathBytes.enumerated() { destination[offset] = CChar(bitPattern: byte) }
            destination[pathBytes.count] = 0
        }
    }
    let addressLength = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, addressLength) }
    }
    guard bound == 0, listen(fd, 8) == 0 else {
        FileHandle.standardError.write(
            "broker: bind/listen failed at \(socketPath) (errno \(errno))\n".data(using: .utf8)!)
        exit(70)
    }

    var lastActivity = Date()
    while true {
        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let elapsedMs = Int(Date().timeIntervalSince(lastActivity) * 1000)
        let timeout: Int32 = idleMs > 0 ? Int32(max(0, idleMs - elapsedMs)) : -1
        let ready = poll(&descriptor, 1, timeout)
        if ready == 0 && idleMs > 0 {
            exit(0)  // idle: an unattended helper does not linger
        }
        if ready < 0 {
            if errno == EINTR { continue }
            continue
        }
        let client = accept(fd, nil, nil)
        if client < 0 { continue }
        serveBrokerClient(client)
        close(client)
        lastActivity = Date()
    }
}

/// Largest request line accepted. The observe-only methods take a handful of small fields, so this
/// is generous; its purpose is that a client which never sends a newline cannot grow the helper's
/// buffer without bound. The node_repl bridge caps its own request at 1 MiB, so the two agree.
private let maxRequestLineBytes = 1024 * 1024

/// Read newline-delimited requests from one client until it disconnects.
///
/// A malformed line produces a `bad_request` response and the connection keeps working: a bad
/// line must never be able to take the helper down or wedge the client. A line that never ends is
/// the same failure in a different shape — it is answered and then dropped.
func serveBrokerClient(_ client: Int32) {
    // Resolve the caller once per connection. Its pid comes from the kernel (LOCAL_PEERPID), not
    // from anything the caller said, and is validated as a code signature — the same check
    // applied to the helper itself.
    let peer = peerCodeIdentity(client)
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let readCount = read(client, &chunk, chunk.count)
        if readCount <= 0 { break }
        buffer.append(contentsOf: chunk[0..<readCount])
        if buffer.count > maxRequestLineBytes, buffer.firstIndex(of: 0x0A) == nil {
            sendBrokerResponse(
                brokerFail("request line exceeded \(maxRequestLineBytes) bytes", code: "bad_request",
                           id: nil), to: client)
            break
        }
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            let response: [String: Any]
            if let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] {
                response = brokerDispatch(object, peer: peer)
            } else {
                response = brokerFail("request line is not a JSON object", code: "bad_request",
                                      id: nil)
            }
            sendBrokerResponse(response, to: client)
        }
    }
}

/// Write one response. A client that disappears mid-write must not take the helper down, so a
/// partial write ends the attempt instead of aborting the process (SIGPIPE is already ignored).
private func sendBrokerResponse(_ response: [String: Any], to client: Int32) {
    var outbound = brokerSerialize(response)
    outbound.append(0x0A)
    outbound.withUnsafeBytes { pointer in
        var written = 0
        while written < outbound.count {
            let count = write(client, pointer.baseAddress!.advanced(by: written),
                              outbound.count - written)
            if count <= 0 { return }
            written += count
        }
    }
}
