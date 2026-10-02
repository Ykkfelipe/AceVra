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
    // 修复依据（installed 92454874 调查）：序列化失败（如结果里出现 NaN/Infinity）时，旧代码写出
    // 空 Data，接着补一个换行——宿主读到空行，JSON.parse 失败后按"畸形消息"切断连接，Helper
    // 读到 EOF 后 exit(0)，表现就是"Helper 无故退出 + 所有后续调用 (unknown): failed"。
    // 先用 isValidJSONObject 预检（它对 NaN/Infinity 返回 false，也避免抛 ObjC 异常），失败时
    // 回一个带原 id 的结构化错误，连接保持可用。
    if JSONSerialization.isValidJSONObject(object),
       let data = try? JSONSerialization.data(withJSONObject: object, options: []) {
        return data
    }
    var fallback: [String: Any] = [
        "ok": false,
        "error": ["message": "the helper produced a result that is not valid JSON",
                  "code": "invalid_result"],
    ]
    if let id = object["id"] as? String { fallback["id"] = id }
    return (try? JSONSerialization.data(withJSONObject: fallback, options: []))
        ?? Data(#"{"ok":false,"error":{"message":"invalid result","code":"invalid_result"}}"#.utf8)
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
    if ["workspace_click", "workspace_type_text", "workspace_scroll", "workspace_confirm", "open_app"].contains(method),
       !cuaHostConnectSessionActive {
        return brokerFail("workspace actions require the peer-bound host session",
                          code: "not_authorized", id: request["id"])
    }
    let params = request["params"] as? [String: Any] ?? [:]
    if ["acquire_control", "release_control", "activate_target", "move_pointer", "click",
        "type_text", "key_press", "scroll", "drag"].contains(method),
       !validForegroundBrokerParams(method, params) {
        return brokerFail("foreground request shape is invalid", code: "bad_request", id: request["id"])
    }
    switch method {
    case "workspace_scroll":
        return brokerOk(WorkspaceController.scroll(params), id: request["id"])
    case "workspace_stream":
        return brokerOk(workspaceStreamCommand(params), id: request["id"])
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
    case "open_app":
        guard Set(params.keys).isSubset(of: ["bundle_id"]) else {
            return brokerFail("open_app accepts only bundle_id", code: "bad_request",
                              id: request["id"])
        }
        return brokerOk(performOpenApp(params), id: request["id"])
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
    case "workspace_click":
        guard WorkspaceController.validClickParams(params) else {
            return brokerFail("workspace_click request shape is invalid", code: "bad_request",
                              id: request["id"])
        }
        return brokerOk(WorkspaceController.click(params), id: request["id"])
    case "workspace_type_text":
        guard WorkspaceController.validTypeParams(params) else {
            return brokerFail("workspace_type_text request shape is invalid", code: "bad_request",
                              id: request["id"])
        }
        return brokerOk(WorkspaceController.typeText(params), id: request["id"])
    case "workspace_confirm":
        guard Set(params.keys).isSubset(of: ["pid", "window_ordinal", "target_label",
                                              "owner_session", "owner_task"]) else {
            return brokerFail("workspace_confirm accepts only pid, window_ordinal, target_label",
                              code: "bad_request", id: request["id"])
        }
        return brokerOk(WorkspaceController.confirm(params), id: request["id"])
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
            // 只有 IDLE 才能被通用空闲计时器结束（HelperLifecycle.swift）：PROTECTED_ACTIVE /
            // PROTECTED_ENDING 不是 idle。重置窗口继续服务；租约结束后恢复原有的"不逗留"语义。
            let elapsed = Int(Date().timeIntervalSince(lastActivity) * 1000)
            let state = ForegroundController.shared.lifecycleState(msSinceActivity: elapsed,
                                                                    idleMs: idleMs)
            if !helperMayExitOnIdle(state) {
                lastActivity = Date()
                continue
            }
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
/// Connection lifecycle: EOF from the host ends the helper (exit 0) unless it holds an exclusive
/// lease (PROTECTED_ACTIVE). Then it releases held input, keeps the lease for a bounded reconnect
/// grace (`protectedReconnectGraceMs`), and either re-attaches to the same host as a new
/// connection generation (the old lease is fenced) or ends the lease and exits when the grace
/// runs out. The host relays client traffic over this connection; a helper restart is a fresh
/// launch + fresh handshake, and the host re-admits a new connection only after this one closes.
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

    var fd: Int32
    switch connectAndAnnounce(socketPath: socketPath, launchToken: launchToken,
                              timeoutMs: connectTimeoutMs) {
    case .connected(let connected): fd = connected
    case .failed(let status, let message):
        FileHandle.standardError.write("broker: \(message)\n".data(using: .utf8)!)
        exit(status)
    }

    while true {
        // The verified host is the only caller on this connection; its identity was checked
        // against the pinned requirement, so serve without the per-connection peer gate.
        cuaHostConnectSessionActive = true
        serveBrokerRequests(fd, peer: nil)
        // No actuation while no authenticated host is attached.
        cuaHostConnectSessionActive = false
        close(fd)

        // Phase 3（proven installed 92454874：Helper 只在宿主 EOF 时 exit(0)）。断开时按生命周期
        // 状态决定：无保护状态立即退出（原行为）；PROTECTED_ACTIVE 进入有界重连宽限；
        // PROTECTED_ENDING 先完成清理再退出。安全不变量：AceVra 故障 → 用户拿回控制。
        let state = ForegroundController.shared.lifecycleState(msSinceActivity: 0, idleMs: 0)
        guard case .reconnectWithinGrace(let graceMs) = hostDisconnectAction(state) else { break }
        // 宽限开始前立刻释放所有合成按键/按钮，用户输入在 AceVra 不可达期间绝不被半截组合键卡住。
        ForegroundController.shared.releaseHeldInputNow()
        FileHandle.standardError.write(
            "broker: host transport lost while protected; reconnect grace \(graceMs) ms\n"
                .data(using: .utf8)!)
        guard let reconnected = reconnectWithinGrace(socketPath: socketPath,
                                                     launchToken: launchToken,
                                                     graceMs: graceMs) else {
            // 宽限到期，宿主没有回来：结束租约（释放输入/tap/锁），把控制交还用户，然后退出。
            ForegroundController.shared.endLease(reason: graceExpiredLeaseCode)
            break
        }
        // 新连接是新代际：原生租约绝不跨代际存活。运行时经仍有效的 ProtectedForegroundGrant
        // 重新获取一个新租约；旧代际租约在此栅栏。
        ForegroundController.shared.endLease(reason: reconnectFencedLeaseCode)
        fd = reconnected
    }
    finishProtectedStateAndExit()
}

/// Bounded PROTECTED_ENDING: cleanup runs off the main thread and the process exits when it
/// finishes or when protectedEndingSafetyMs elapses, whichever comes first. Exit drops the tap
/// and the desktop lock in any case, so the user regains control either way.
private func finishProtectedStateAndExit() -> Never {
    let done = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
        ForegroundController.shared.shutdown()
        done.signal()
    }
    _ = done.wait(timeout: .now() + .milliseconds(protectedEndingSafetyMs))
    exit(0)  // the host session ended; an unattended helper does not linger
}

private enum HostConnectOutcome {
    case connected(Int32)
    case failed(Int32, String)
}

/// Connect, verify the listener's code identity against the pinned requirement, and send the
/// hello. Used for the first connection and for each reconnect attempt inside the grace: a
/// reconnect is authenticated exactly like a first connection (fresh peer verification, the same
/// launch token), and the host admits it as a new connection generation.
private func connectAndAnnounce(socketPath: String, launchToken: String,
                                timeoutMs: Int) -> HostConnectOutcome {
    let fd = connectBrokerSocket(path: socketPath, timeoutMs: timeoutMs)
    guard fd >= 0 else {
        return .failed(71, "could not connect to the host session socket (errno \(errno))")
    }
    // Verify the listener BEFORE any payload-bearing traffic. `hello` carries the launch token
    // and the verified identity only after the host's code satisfied the requirement.
    let host = hostPeerIdentity(fd)
    guard host.verified else {
        close(fd)
        return .failed(77, "host identity verification failed: \(host.reason)")
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
        close(fd)
        return .failed(72, "host closed during hello")
    }
    return .connected(fd)
}

/// Try to re-attach to the same authoritative host for at most `graceMs`. A host that stopped
/// removed its socket, so attempts fail fast and the grace simply runs out.
private func reconnectWithinGrace(socketPath: String, launchToken: String,
                                  graceMs: Int) -> Int32? {
    let deadline = Date().addingTimeInterval(Double(graceMs) / 1000.0)
    while Date() < deadline {
        let remaining = Int(deadline.timeIntervalSinceNow * 1000)
        if case .connected(let fd) = connectAndAnnounce(socketPath: socketPath,
                                                        launchToken: launchToken,
                                                        timeoutMs: max(50, min(500, remaining))) {
            return fd
        }
        Thread.sleep(forTimeInterval: 0.25)
    }
    return nil
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
        // EINTR 不是断开：以前 read 返回 -1 就当作 EOF，被信号打断也会结束会话并退出。
        if readCount < 0 && errno == EINTR { continue }
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
