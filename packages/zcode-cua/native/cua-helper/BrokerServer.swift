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

/// Set only after the pinned host-connect handshake succeeds. Legacy bind mode never has an
/// actuator capability, even when a method name is otherwise recognized.
var cuaHostConnectSessionActive = false

/// Route one request. Only the explicit CUA-2 semantic methods can reach the AX actuator.
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
    guard supportedBrokerMethods.contains(method) else {
        return brokerFail(
            "method '\(method)' is not available", code: "not_authorized",
            id: request["id"])
    }
    if ["press", "set_value", "control_status", "acquire_control", "release_control", "activate_target",
        "move_pointer", "click", "type_text", "key_press", "scroll", "drag"].contains(method),
       !cuaHostConnectSessionActive {
        return brokerFail("semantic actions require the peer-bound host session",
                          code: "not_authorized", id: request["id"])
    }
    let params = request["params"] as? [String: Any] ?? [:]
    if ["acquire_control", "release_control", "activate_target", "move_pointer", "click",
        "type_text", "key_press", "scroll", "drag"].contains(method),
       !validForegroundBrokerParams(method, params) {
        return brokerFail("foreground request shape is invalid", code: "bad_request", id: request["id"])
    }
    switch method {
    case "permission_status":
        return brokerOk(permissionStatusResult(peer: peer), id: request["id"])
    case "control_status":
        guard Set(params.keys) == ["lease_id"] else {
            return brokerFail("control_status requires lease_id", code: "bad_request", id: request["id"])
        }
        return brokerOk(ForegroundController.shared.status(params), id: request["id"])
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
    case "press":
        guard Set(params.keys).isSubset(of: ["semantic_ref"]) else {
            return brokerFail("press accepts only semantic_ref", code: "bad_request", id: request["id"])
        }
        var result = performSemanticPress(params)
        result.merge(brokerEnvelope(route: result["route"] as? String ?? "accessibility_action",
                                    effect: result["effect"] as? String ?? "unknown")) {
            current, _ in current
        }
        return brokerOk(result, id: request["id"])
    case "set_value":
        guard Set(params.keys).isSubset(of: ["semantic_ref", "value"]) else {
            return brokerFail("set_value accepts only semantic_ref and value",
                              code: "bad_request", id: request["id"])
        }
        var result = performSemanticSetValue(params)
        result.merge(brokerEnvelope(route: result["route"] as? String ?? "accessibility_action",
                                    effect: result["effect"] as? String ?? "unknown")) {
            current, _ in current
        }
        return brokerOk(result, id: request["id"])
    case "acquire_control":
        return brokerOk(ForegroundController.shared.acquire(params), id: request["id"])
    case "release_control":
        return brokerOk(ForegroundController.shared.release(params), id: request["id"])
    case "activate_target":
        return brokerOk(ForegroundController.shared.activate(params), id: request["id"])
    case "move_pointer":
        return brokerOk(ForegroundController.shared.movePointer(params), id: request["id"])
    case "click":
        return brokerOk(ForegroundController.shared.click(params), id: request["id"])
    case "type_text":
        return brokerOk(ForegroundController.shared.typeText(params), id: request["id"])
    case "key_press":
        return brokerOk(ForegroundController.shared.keyPress(params), id: request["id"])
    case "scroll":
        return brokerOk(ForegroundController.shared.scroll(params), id: request["id"])
    case "drag":
        return brokerOk(ForegroundController.shared.drag(params), id: request["id"])
    default:
        return brokerFail("unreachable", code: "internal", id: request["id"])
    }
}

private func validForegroundBrokerParams(_ method: String, _ params: [String: Any]) -> Bool {
    let common: Set<String> = ["owner_session", "owner_task"]
    let fields: Set<String>
    switch method {
    case "acquire_control": fields = ["observation_id"]
    case "release_control": fields = ["lease_id"]
    case "activate_target": fields = ["lease_id", "observation_id"]
    case "move_pointer", "click": fields = ["lease_id", "observation_id", "point"]
    case "type_text": fields = ["lease_id", "observation_id", "text"]
    case "key_press": fields = ["lease_id", "observation_id", "key", "modifiers"]
    case "scroll": fields = ["lease_id", "observation_id", "point", "delta_x", "delta_y"]
    case "drag": fields = ["lease_id", "observation_id", "start", "end"]
    default: return false
    }
    guard Set(params.keys) == common.union(fields) else { return false }
    for key in ["owner_session", "owner_task"] {
        guard let value = params[key] as? String, !value.isEmpty, value.count <= 128,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        else { return false }
    }
    return true
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
    // Least privilege for the socket file: the accept loop only needs the owner. The parent
    // directory is the launcher's data root; in host-connect mode (CUA-1.5) the helper binds
    // nothing at all, and this chmod keeps the standalone bind mode from relying on the
    // launching process's umask.
    chmod(socketPath, 0o600)

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

// MARK: - Host-owned transport (CUA-1.5)

/// Connect out to the host-owned session socket, verify the listener's code identity against
/// the launcher-pinned requirement, announce this helper, and serve the observe-only broker
/// protocol on that one connection.
///
/// Note on `idleMs`: deliberately not applied in connect mode. Unlike bind mode, an idle
/// connection here is a live host session — the host owns the lifetime and closes the
/// connection when the session ends, and EOF (not idleness) is what ends this helper. The
/// argument is accepted because the launch contract always passes it.
///
/// Why connect instead of bind (spec "Why the transport direction flips"): the clients of a
/// bound socket are Node processes with no peer-credential binding, so a same-uid impostor that
/// won the bind race owned every client's identity decision. Here the *serving* party is the
/// connection initiator: the pid on the far end comes from the kernel (`LOCAL_PEERPID`), and a
/// listener whose code does not satisfy `cuaIdentityPolicy.requiredHostRequirement` receives
/// nothing — the helper exits without serving, so substitution destroys the capability instead
/// of redirecting it.
///
/// Connection lifecycle: EOF from the host ends the helper (exit 0). The host relays client
/// traffic over this connection; a helper restart is a fresh launch + fresh handshake, and the
/// host re-admits a new connection only after this one closes.
func runBrokerHostClient(socketPath: String, launchToken: String, connectTimeoutMs: Int,
                         idleMs: Int) -> Never {
    signal(SIGPIPE, SIG_IGN)

    guard !cuaIdentityPolicy.requiredHostRequirement.isEmpty else {
        // Fail closed at launch, not at the first connection: a host-connect helper without a
        // pinned listener requirement would serve whatever holds the socket.
        FileHandle.standardError.write(
            "broker: --connect requires --require-host-requirement\n".data(using: .utf8)!)
        exit(78)
    }

    let fd = connectBrokerSocket(path: socketPath, timeoutMs: connectTimeoutMs)
    guard fd >= 0 else {
        FileHandle.standardError.write(
            "broker: could not connect to the host session socket (errno \(errno))\n"
                .data(using: .utf8)!)
        exit(71)
    }

    // Verify the listener BEFORE any payload-bearing traffic. `hello` carries the launch token
    // and the verified identity only after the host's code satisfied the requirement.
    let host = hostPeerIdentity(fd)
    guard host.verified else {
        FileHandle.standardError.write(
            "broker: host identity verification failed: \(host.reason)\n".data(using: .utf8)!)
        close(fd)
        exit(77)
    }

    let hello: [String: Any] = [
        "ok": true,
        "result": [
            "type": "helper_hello",
            "transport": "host-connect",
            "launch_token": launchToken,
            "helper_identity": helperSelfIdentity.json,
            "pid": Int(getpid()),
        ],
    ]
    var helloData = brokerSerialize(hello)
    helloData.append(0x0A)
    if !writeAll(fd, helloData) {
        FileHandle.standardError.write("broker: host closed during hello\n".data(using: .utf8)!)
        exit(72)
    }

    // The verified host is the only caller on this connection; its identity was checked against
    // the pinned requirement above, so serve without the per-connection peer gate bind mode uses.
    cuaHostConnectSessionActive = true
    serveBrokerRequests(fd, peer: nil)
    ForegroundController.shared.shutdown()
    close(fd)
    exit(0)  // the host session ended; an unattended helper does not linger
}

/// Connect to a Unix socket with bounded retries. The host binds before launching, so the first
/// attempt normally succeeds; the retries cover scheduler jitter between `open` and `listen`.
private func connectBrokerSocket(path: String, timeoutMs: Int) -> Int32 {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    while true {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return -1 }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            close(fd)
            return -1
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count + 1) {
                destination in
                for (offset, byte) in pathBytes.enumerated() {
                    destination[offset] = CChar(bitPattern: byte)
                }
                destination[pathBytes.count] = 0
            }
        }
        let addressLength = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, addressLength)
            }
        }
        if connected == 0 { return fd }
        close(fd)
        if Date() >= deadline { return -1 }
        Thread.sleep(forTimeInterval: 0.05)
    }
}

/// Write a full buffer, tolerating partial writes. A vanished reader ends the attempt instead
/// of aborting the process (SIGPIPE is already ignored).
private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { pointer in
        var written = 0
        while written < data.count {
            let count = write(fd, pointer.baseAddress!.advanced(by: written),
                              data.count - written)
            if count <= 0 { return false }
            written += count
        }
        return true
    }
}

/// Largest request line accepted. The observe-only methods take a handful of small fields, so this
/// is generous; its purpose is that a client which never sends a newline cannot grow the helper's
/// buffer without bound. The node_repl bridge caps its own request at 1 MiB, so the two agree.
private let maxRequestLineBytes = 1024 * 1024

/// Read newline-delimited requests from one client until it disconnects (bind mode entry:
/// resolves the caller once per connection, from the kernel, before serving).
///
/// A malformed line produces a `bad_request` response and the connection keeps working: a bad
/// line must never be able to take the helper down or wedge the client. A line that never ends is
/// the same failure in a different shape — it is answered and then dropped.
func serveBrokerClient(_ client: Int32) {
    // Resolve the caller once per connection. Its pid comes from the kernel (LOCAL_PEERPID), not
    // from anything the caller said, and is validated as a code signature — the same check
    // applied to the helper itself.
    let peer = peerCodeIdentity(client)
    serveBrokerRequests(client, peer: peer)
}

/// The request loop shared by bind mode (`serveBrokerClient`) and host-connect mode
/// (`runBrokerHostClient`). In host-connect mode `peer` is nil by design: the far end was
/// already verified against the launcher-pinned requirement before the hello, and this
/// connection has exactly one possible peer.
private func serveBrokerRequests(_ client: Int32, peer: CodeIdentityReport?) {
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
