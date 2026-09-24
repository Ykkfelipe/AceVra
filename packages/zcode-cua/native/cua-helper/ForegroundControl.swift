// CUA-3 foreground input. The signed, peer-bound Helper is the only actuator and lease owner.
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

private let foregroundObservationAge: TimeInterval = 3
private let foregroundLeaseLifetime: TimeInterval = 15

private struct ForegroundDisplay: Equatable {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let pixelWidth: Int
    let pixelHeight: Int

    var json: [String: Any] {
        ["id": Int(id), "bounds": rectJSON(bounds), "pixels": ["w": pixelWidth, "h": pixelHeight],
         "scale": ["x": Double(pixelWidth) / Double(bounds.width),
                   "y": Double(pixelHeight) / Double(bounds.height)]]
    }
}

private struct ForegroundObservation {
    let id: String
    let time: Date
    let pid: pid_t
    let windowId: CGWindowID
    let windowBounds: CGRect
    let displays: [ForegroundDisplay]
}

private final class ForegroundLease {
    let id: String
    let ownerSession: String
    let ownerTask: String
    let acquired: Date
    let deadline: Date
    var observation: ForegroundObservation
    let marker: Int64
    var heldMouse = false
    var heldKey: CGKeyCode?
    var interrupted = false
    var observedOwnEvents = 0

    init(session: String, task: String, observation: ForegroundObservation) {
        id = UUID().uuidString.lowercased()
        ownerSession = session
        ownerTask = task
        acquired = Date()
        deadline = acquired.addingTimeInterval(foregroundLeaseLifetime)
        self.observation = observation
        marker = Int64.random(in: 1...Int64.max)
    }
}

private func rectJSON(_ rect: CGRect) -> [String: Double] {
    ["x": Double(rect.minX), "y": Double(rect.minY),
     "w": Double(rect.width), "h": Double(rect.height)]
}

private func currentDisplays() -> [ForegroundDisplay]? {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(32, &ids, &count) == .success, count > 0 else { return nil }
    return ids.prefix(Int(count)).map { id in
        ForegroundDisplay(id: id, bounds: CGDisplayBounds(id),
                          pixelWidth: CGDisplayPixelsWide(id), pixelHeight: CGDisplayPixelsHigh(id))
    }.sorted { $0.id < $1.id }
}

private func currentWindow(_ id: CGWindowID, pid: pid_t) -> CGRect? {
    let items = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
    guard items.count == 1, let item = items.first,
          (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id,
          (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          let bounds = item[kCGWindowBounds as String] as? [String: NSNumber],
          let x = bounds["X"]?.doubleValue, let y = bounds["Y"]?.doubleValue,
          let w = bounds["Width"]?.doubleValue, let h = bounds["Height"]?.doubleValue,
          w >= 40, h >= 40 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

private func tapMask() -> CGEventMask {
    let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .mouseMoved,
                                .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                .otherMouseDown, .otherMouseUp, .leftMouseDragged,
                                .rightMouseDragged, .otherMouseDragged, .scrollWheel]
    return types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
}

private func foregroundTapCallback(
    _ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent,
    _ userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let controller = Unmanaged<ForegroundController>.fromOpaque(userInfo).takeUnretainedValue()
    controller.received(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

final class ForegroundController {
    static let shared = ForegroundController()
    private let lock = NSLock()
    private var observations: [String: ForegroundObservation] = [:]
    private var lease: ForegroundLease?
    private var ending = false
    private var lastInterruptedId: String?
    private var lastInterruptionAt: Date?
    private var lastTerminationCode: String?
    private var lastReleasedOwnerSession: String?
    private var lastReleasedOwnerTask: String?
    private var lastReleasedAt: Date?
    private var globalLockFd: Int32 = -1
    private var tap: CFMachPort?
    private var tapLoop: CFRunLoop?

    private init() {}

    func rememberObservation(pid: pid_t, windowId: CGWindowID?) -> [String: Any]? {
        guard let windowId, let bounds = currentWindow(windowId, pid: pid),
              let displays = currentDisplays() else { return nil }
        let observation = ForegroundObservation(id: UUID().uuidString.lowercased(), time: Date(),
                                                 pid: pid, windowId: windowId,
                                                 windowBounds: bounds, displays: displays)
        lock.lock()
        observations = observations.filter { Date().timeIntervalSince($0.value.time) < foregroundObservationAge }
        observations[observation.id] = observation
        lock.unlock()
        return ["observation_id": observation.id,
                "observed_at_ms": Int(observation.time.timeIntervalSince1970 * 1000),
                "coordinate_space": "quartz_global_points_top_left",
                "target_pid": Int(pid), "target_window_id": Int(windowId),
                "window_bounds": rectJSON(bounds), "displays": displays.map(\.json)]
    }

    private func lookup(_ id: String) -> ForegroundObservation? {
        lock.lock()
        defer { lock.unlock() }
        guard let observation = observations[id],
              Date().timeIntervalSince(observation.time) <= foregroundObservationAge,
              currentWindow(observation.windowId, pid: observation.pid) == observation.windowBounds,
              currentDisplays() == observation.displays else { return nil }
        return observation
    }

    private func acquireGlobalLock() -> Bool {
        let path = "/tmp/acevra-cua-exclusive-\(getuid()).lock"
        let fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return false }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(), metadata.st_nlink == 1,
              flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return false
        }
        globalLockFd = fd
        return true
    }

    private func releaseGlobalLock() {
        if globalLockFd >= 0 {
            flock(globalLockFd, LOCK_UN)
            close(globalLockFd)
            globalLockFd = -1
        }
    }

    private func installTap() -> Bool {
        let ready = DispatchSemaphore(value: 0)
        var installed = false
        Thread.detachNewThread { [self] in
            let info = Unmanaged.passUnretained(self).toOpaque()
            let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                            options: .listenOnly, eventsOfInterest: tapMask(),
                                            callback: foregroundTapCallback, userInfo: info)
            if let created, let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) {
                let loop = CFRunLoopGetCurrent()
                lock.lock()
                tap = created
                tapLoop = loop
                lock.unlock()
                CFRunLoopAddSource(loop, source, .commonModes)
                CGEvent.tapEnable(tap: created, enable: true)
                let timer = Timer(timeInterval: 0.025, repeats: true) { [weak self] _ in
                    self?.expireIfNeeded()
                }
                RunLoop.current.add(timer, forMode: .common)
                installed = CGEvent.tapIsEnabled(tap: created)
                ready.signal()
                if installed { CFRunLoopRun() }
                timer.invalidate()
                CFRunLoopRemoveSource(loop, source, .commonModes)
                CFMachPortInvalidate(created)
            } else {
                ready.signal()
            }
        }
        return ready.wait(timeout: .now() + .seconds(2)) == .success && installed
    }

    private func stopTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let tapLoop { CFRunLoopStop(tapLoop) }
        tap = nil
        tapLoop = nil
    }

    private func tagged(_ event: CGEvent, marker: Int64) -> CGEvent {
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        return event
    }

    private func cleanupHeldInput(_ current: ForegroundLease) {
        let point = CGEvent(source: nil)?.location ?? CGPoint.zero
        lock.lock()
        let mouseHeld = current.heldMouse
        let keyHeld = current.heldKey
        current.heldMouse = false
        current.heldKey = nil
        lock.unlock()
        if mouseHeld,
           let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                            mouseCursorPosition: point, mouseButton: .left) {
            tagged(up, marker: current.marker).post(tap: .cghidEventTap)
        }
        if let key = keyHeld,
           let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) {
            tagged(up, marker: current.marker).post(tap: .cghidEventTap)
        }
    }

    private func endLease(code: String) {
        lock.lock()
        guard let current = lease else { lock.unlock(); return }
        lease = nil
        ending = true
        lastInterruptedId = current.id
        lastInterruptionAt = Date()
        lastTerminationCode = code
        if code == "released" {
            lastReleasedOwnerSession = current.ownerSession
            lastReleasedOwnerTask = current.ownerTask
            lastReleasedAt = Date()
        }
        lock.unlock()
        cleanupHeldInput(current)
        stopTap()
        releaseGlobalLock()
        lock.lock()
        ending = false
        lock.unlock()
    }

    func received(type: CGEventType, event: CGEvent) {
        lock.lock()
        let current = lease
        let marker = event.getIntegerValueField(.eventSourceUserData)
        let own = current != nil && marker == current?.marker
        if own { current?.observedOwnEvents += 1 }
        lock.unlock()
        if foregroundEventInterrupts(type, marker: marker, currentMarker: current?.marker) {
            endLease(code: "interrupted")
        }
    }

    private func expireIfNeeded() {
        lock.lock()
        let current = lease
        let enabled = tap.map { CGEvent.tapIsEnabled(tap: $0) } == true
        lock.unlock()
        if let current, Date() >= current.deadline { endLease(code: "lease_expired") }
        else if current != nil && !enabled { endLease(code: "input_monitoring_lost") }
    }

    func acquire(_ params: [String: Any]) -> [String: Any] {
        guard cuaHostConnectSessionActive else { return foregroundRefusal("not_authorized") }
        guard AXIsProcessTrusted() else { return foregroundRefusal("permission_required") }
        guard let session = params["owner_session"] as? String, !session.isEmpty,
              let task = params["owner_task"] as? String, !task.isEmpty,
              let observationId = params["observation_id"] as? String,
              let observation = lookup(observationId) else { return foregroundRefusal("stale_geometry") }
        lock.lock()
        let busy = lease != nil || ending
        lock.unlock()
        guard !busy, acquireGlobalLock() else { return foregroundRefusal("exclusive_busy") }
        guard installTap() else {
            stopTap()
            releaseGlobalLock()
            return foregroundRefusal("input_monitoring_required")
        }
        let current = ForegroundLease(session: session, task: task, observation: observation)
        lock.lock()
        lease = current
        lock.unlock()
        return foregroundResult("acquire_control", effect: "confirmed", current: current,
                                evidence: [["kind": "exclusive_lease", "state": "active"]])
    }

    fileprivate func checkedLease(_ params: [String: Any], observationRequired: Bool = true) -> (ForegroundLease?, String?) {
        guard let id = params["lease_id"] as? String,
              let session = params["owner_session"] as? String,
              let task = params["owner_task"] as? String else { return (nil, "invalid_lease") }
        lock.lock()
        let current = lease
        let terminated = lastInterruptedId == id && lastInterruptionAt.map {
            Date().timeIntervalSince($0) < 30
        } == true
        let terminationCode = lastTerminationCode
        let tapReady = tap.map { CGEvent.tapIsEnabled(tap: $0) } == true
        lock.unlock()
        if terminated { return (nil, terminationCode ?? "invalid_lease") }
        guard let current, current.id == id, current.ownerSession == session,
              current.ownerTask == task else { return (nil, "invalid_lease") }
        if Date() >= current.deadline || !tapReady {
            endLease(code: tapReady ? "lease_expired" : "input_monitoring_lost")
            return (nil, tapReady ? "lease_expired" : "input_monitoring_lost")
        }
        if observationRequired {
            guard let obs = params["observation_id"] as? String,
                  let refreshed = lookup(obs),
                  refreshed.pid == current.observation.pid,
                  refreshed.windowId == current.observation.windowId else {
                endLease(code: "stale_geometry")
                return (nil, "stale_geometry")
            }
            current.observation = refreshed
        }
        return (current, nil)
    }

    func release(_ params: [String: Any]) -> [String: Any] {
        guard let id = params["lease_id"] as? String,
              let session = params["owner_session"] as? String,
              let task = params["owner_task"] as? String else {
            return foregroundRefusal("invalid_lease")
        }
        lock.lock()
        let alreadyReleased = lease == nil && lastInterruptedId == id
            && lastTerminationCode == "released"
            && lastReleasedOwnerSession == session && lastReleasedOwnerTask == task
            && lastReleasedAt.map { Date().timeIntervalSince($0) < 30 } == true
        lock.unlock()
        if alreadyReleased { return releasedResult(id) }
        let (current, error) = checkedLease(params, observationRequired: false)
        guard let current else { return foregroundRefusal(error ?? "invalid_lease") }
        endLease(code: "released")
        return foregroundResult("release_control", effect: "confirmed", current: current,
                                evidence: [["kind": "exclusive_lease", "state": "released"]],
                                leaseState: "released")
    }

    func shutdown() { endLease(code: "shutdown") }

    func status(_ params: [String: Any]) -> [String: Any] {
        let id = params["lease_id"] as? String ?? ""
        lock.lock()
        let state: String
        if lease?.id == id { state = "active" }
        else if lastInterruptedId == id && lastInterruptionAt.map({ Date().timeIntervalSince($0) < 30 }) == true {
            state = lastTerminationCode ?? "inactive"
        } else { state = "unknown" }
        lock.unlock()
        return ["effect": "confirmed", "route": "none", "evidence": [],
                "lease_state": state, "helper_identity": shortIdentityJSON(helperSelfIdentity),
                "delivery": ["mode": "background"]]
    }

    fileprivate func stillActive(_ current: ForegroundLease) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return lease === current && !current.interrupted && Date() < current.deadline
            && tap.map { CGEvent.tapIsEnabled(tap: $0) } == true
    }

    fileprivate func postedCount(_ current: ForegroundLease) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return current.observedOwnEvents
    }

    fileprivate func setMouseHeld(_ current: ForegroundLease, held: Bool) {
        lock.lock()
        current.heldMouse = held
        lock.unlock()
    }

    fileprivate func setKeyHeld(_ current: ForegroundLease, key: CGKeyCode?) {
        lock.lock()
        current.heldKey = key
        lock.unlock()
    }

    fileprivate func post(_ event: CGEvent, current: ForegroundLease) -> Bool {
        guard stillActive(current) else { return false }
        tagged(event, marker: current.marker).post(tap: .cghidEventTap)
        return true
    }

    fileprivate func confirmedDelivery(_ current: ForegroundLease, since count: Int,
                                       expected: Int) -> Bool {
        let deadline = Date().addingTimeInterval(0.15)
        while Date() < deadline {
            if postedCount(current) - count >= expected { return true }
            if !stillActive(current) { return false }
            Thread.sleep(forTimeInterval: 0.005)
        }
        return false
    }
}

func foregroundRefusal(_ code: String) -> [String: Any] {
    ["effect": "refused", "code": code, "route": "none", "evidence": [],
     "classification": "REQUIRES_FOREGROUND", "input_delivery": "none",
     "application_effect": "unknown", "mode": "EXCLUSIVE_FOREGROUND",
     "lease_state": code == "interrupted" ? "interrupted" : "inactive",
     "helper_identity": shortIdentityJSON(helperSelfIdentity),
     "delivery": ["mode": "exclusive_foreground"]]
}

private func foregroundResult(_ operation: String, effect: String, current: ForegroundLease,
                              evidence: [[String: Any]], delivery: String = "none",
                              application: String = "unknown", leaseState: String = "active") -> [String: Any] {
    ["operation": operation, "effect": effect, "route": "quartz_input", "evidence": evidence,
     "classification": "REQUIRES_FOREGROUND", "input_delivery": delivery,
     "application_effect": application, "mode": "EXCLUSIVE_FOREGROUND",
     "lease_id": current.id, "lease_state": leaseState,
     "helper_identity": shortIdentityJSON(helperSelfIdentity),
     "delivery": ["mode": "exclusive_foreground"]]
}

private func releasedResult(_ id: String) -> [String: Any] {
    ["operation": "release_control", "effect": "confirmed", "route": "quartz_input",
     "evidence": [["kind": "exclusive_lease", "state": "released"]],
     "classification": "REQUIRES_FOREGROUND", "input_delivery": "none",
     "application_effect": "unknown", "mode": "EXCLUSIVE_FOREGROUND",
     "lease_id": id, "lease_state": "released",
     "helper_identity": shortIdentityJSON(helperSelfIdentity),
     "delivery": ["mode": "exclusive_foreground"]]
}

private func focusedAXElement(_ pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString,
                                        &value) == .success, let value,
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func axParent(_ element: AXUIElement) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func topmostWindow(at point: CGPoint, pid: pid_t? = nil) -> CGWindowID? {
    let items = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                           kCGNullWindowID) as? [[String: Any]] ?? []
    for item in items {
        guard (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true,
              (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
              let ownerPid = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              pid == nil || ownerPid == pid,
              let bounds = item[kCGWindowBounds as String] as? [String: NSNumber],
              let x = bounds["X"]?.doubleValue, let y = bounds["Y"]?.doubleValue,
              let width = bounds["Width"]?.doubleValue, let height = bounds["Height"]?.doubleValue,
              width > 0, height > 0,
              CGRect(x: x, y: y, width: width, height: height).contains(point),
              let windowId = (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
        return windowId
    }
    return nil
}

private func frontmostWindow(pid: pid_t) -> CGWindowID? {
    let items = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                           kCGNullWindowID) as? [[String: Any]] ?? []
    for item in items {
        guard (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? true,
              (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
              (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let windowId = (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
        return windowId
    }
    return nil
}

private func axText(_ element: AXUIElement, _ key: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else {
        return nil
    }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

private func focusedWindowMatches(_ observation: ForegroundObservation) -> Bool {
    let app = AXUIElementCreateApplication(observation.pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString,
                                        &value) == .success, let value,
          CFGetTypeID(value) == AXUIElementGetTypeID(),
          let position = axPoint(value as! AXUIElement, kAXPositionAttribute as String),
          let size = axSize(value as! AXUIElement, kAXSizeAttribute as String) else { return false }
    let focused = CGRect(origin: position, size: size)
    let expected = observation.windowBounds
    return frontmostWindow(pid: observation.pid) == observation.windowId
        && abs(focused.minX - expected.minX) <= 2
        && abs(focused.minY - expected.minY) <= 2
        && abs(focused.width - expected.width) <= 2
        && abs(focused.height - expected.height) <= 2
}

private func foregroundTargetReady(_ current: ForegroundLease) -> Bool {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == current.observation.pid
        && focusedWindowMatches(current.observation)
}

private func checkedPoint(_ params: [String: Any], _ current: ForegroundLease,
                          key: String = "point") -> CGPoint? {
    guard let raw = params[key] as? [String: NSNumber], let x = raw["x"]?.doubleValue,
          let y = raw["y"]?.doubleValue, x.isFinite, y.isFinite else { return nil }
    let point = CGPoint(x: x, y: y)
    guard current.observation.displays.contains(where: { $0.bounds.contains(point) }),
          current.observation.windowBounds.contains(point) else { return nil }
    return point
}

private func pointBelongsToTarget(_ point: CGPoint, _ current: ForegroundLease) -> Bool {
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y),
                                           &element) == .success,
          let element else { return false }
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success && pid == current.observation.pid
        && topmostWindow(at: point) == current.observation.windowId
}

private struct AXElementProbe {
    let identity: String
    let state: String
}

private func axElementAtPoint(_ point: CGPoint) -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y),
                                           &element) == .success else { return nil }
    return element
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let children = value as? [AXUIElement] else { return [] }
    return children
}

private func axScrollAreaAtPoint(_ point: CGPoint) -> AXUIElement? {
    guard var element = axElementAtPoint(point) else { return nil }
    for _ in 0..<12 {
        if axText(element, kAXRoleAttribute as String) == "AXScrollArea" { return element }
        guard let parent = axParent(element) else { return nil }
        element = parent
    }
    return nil
}

private func axScrollIndicatorAtPoint(_ point: CGPoint) -> AXUIElement? {
    guard let area = axScrollAreaAtPoint(point) else { return nil }
    var pending = axChildren(area)
    var visited = Set<CFHashCode>()
    while !pending.isEmpty {
        let element = pending.removeFirst()
        let hash = CFHash(element)
        guard visited.insert(hash).inserted else { continue }
        if axText(element, kAXRoleAttribute as String) == "AXScrollBar" { return element }
        pending.append(contentsOf: axChildren(element))
    }
    return nil
}

private func axElementProbe(_ element: AXUIElement?) -> AXElementProbe? {
    guard let element else { return nil }
    let position = axPoint(element, kAXPositionAttribute as String)
    let size = axSize(element, kAXSizeAttribute as String)
    let identityFields: [String: Any] = [
        "role": axText(element, kAXRoleAttribute as String) ?? "",
        "subrole": axText(element, kAXSubroleAttribute as String) ?? "",
        "frame": position.flatMap { point in size.map { rectJSON(CGRect(origin: point, size: $0)) } } ?? [:],
    ]
    let stateFields: [String: Any] = [
        "identifier": axText(element, kAXIdentifierAttribute as String) ?? "",
        "label": axText(element, "AXLabel") ?? "",
        "title": axText(element, kAXTitleAttribute as String) ?? "",
        "value": axText(element, kAXValueAttribute as String) ?? "",
        "description": axText(element, "AXDescription") ?? "",
        "enabled": axText(element, kAXEnabledAttribute as String) ?? "",
        "selected": axText(element, kAXSelectedAttribute as String) ?? "",
    ]
    guard let identityData = try? JSONSerialization.data(withJSONObject: identityFields,
                                                          options: [.sortedKeys]),
          let stateData = try? JSONSerialization.data(withJSONObject: stateFields,
                                                        options: [.sortedKeys]) else { return nil }
    return AXElementProbe(identity: String(decoding: identityData, as: UTF8.self),
                          state: String(decoding: stateData, as: UTF8.self))
}

private func inputResult(_ operation: String, _ current: ForegroundLease,
                         delivered: Bool, before: AXElementProbe?, after: AXElementProbe?,
                         extra: [[String: Any]] = []) -> [String: Any] {
    let changed = before != nil && after != nil && before?.state != after?.state
    let application = changed ? "confirmed" : "unknown"
    return foregroundResult(operation, effect: changed ? "confirmed" : "unknown",
                            current: current,
                            evidence: extra + [["kind": "input_delivery", "observed_by_tap": delivered],
                                               ["kind": "application_readback", "changed": changed,
                                                "before_present": before != nil, "after_present": after != nil,
                                                "identity_stable": before?.identity == after?.identity]],
                            delivery: delivered ? "confirmed" : "unknown",
                            application: application)
}

extension ForegroundController {
    func activate(_ params: [String: Any]) -> [String: Any] {
        let (current, code) = checkedLease(params)
        guard let current else { return foregroundRefusal(code ?? "invalid_lease") }
        guard let app = NSRunningApplication(processIdentifier: current.observation.pid) else {
            shutdown()
            return foregroundRefusal("target_lost")
        }
        _ = app.activate(options: [.activateIgnoringOtherApps])
        let deadline = Date().addingTimeInterval(0.5)
        while Date() < deadline && !foregroundTargetReady(current) {
            if !stillActive(current) { return foregroundRefusal("interrupted") }
            Thread.sleep(forTimeInterval: 0.01)
        }
        guard foregroundTargetReady(current) else {
            shutdown()
            return foregroundRefusal("focus_mismatch")
        }
        return foregroundResult("activate_target", effect: "confirmed", current: current,
                                evidence: [["kind": "foreground_readback", "pid": Int(current.observation.pid),
                                            "window_id": Int(current.observation.windowId)]],
                                application: "confirmed")
    }

    func movePointer(_ params: [String: Any]) -> [String: Any] {
        let (current, code) = checkedLease(params)
        guard let current else { return foregroundRefusal(code ?? "invalid_lease") }
        guard let point = checkedPoint(params, current) else { return foregroundRefusal("invalid_coordinate") }
        guard foregroundTargetReady(current), pointBelongsToTarget(point, current) else {
            shutdown(); return foregroundRefusal("focus_mismatch")
        }
        let before = CGEvent(source: nil)?.location ?? CGPoint.zero
        guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                  mouseCursorPosition: point, mouseButton: .left),
              post(event, current: current) else { return foregroundRefusal("interrupted") }
        let deadline = Date().addingTimeInterval(0.15)
        var after = CGEvent(source: nil)?.location ?? CGPoint.zero
        while Date() < deadline && hypot(after.x - point.x, after.y - point.y) > 2 {
            if !stillActive(current) { return foregroundRefusal("interrupted") }
            Thread.sleep(forTimeInterval: 0.005)
            after = CGEvent(source: nil)?.location ?? CGPoint.zero
        }
        let arrived = hypot(after.x - point.x, after.y - point.y) <= 2
        return foregroundResult("move_pointer", effect: arrived ? "confirmed" : "unknown",
                                current: current,
                                evidence: [["kind": "pointer_position", "requested": ["x": point.x, "y": point.y],
                                            "normalized": ["x": point.x, "y": point.y],
                                            "before": ["x": before.x, "y": before.y],
                                            "after": ["x": after.x, "y": after.y]]],
                                delivery: arrived ? "confirmed" : "unknown",
                                application: "unknown")
    }

    func click(_ params: [String: Any]) -> [String: Any] {
        let (current, code) = checkedLease(params)
        guard let current else { return foregroundRefusal(code ?? "invalid_lease") }
        guard let point = checkedPoint(params, current) else { return foregroundRefusal("invalid_coordinate") }
        guard foregroundTargetReady(current), pointBelongsToTarget(point, current) else {
            shutdown(); return foregroundRefusal("focus_mismatch")
        }
        let beforeElement = axElementAtPoint(point)
        let before = axElementProbe(beforeElement)
        let count = postedCount(current)
        setMouseHeld(current, held: true)
        defer { cleanupHeldInput(current) }
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                 mouseCursorPosition: point, mouseButton: .left),
              post(down, current: current) else { return foregroundRefusal("interrupted") }
        guard stillActive(current),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                                mouseCursorPosition: point, mouseButton: .left),
              post(up, current: current) else { return foregroundRefusal("interrupted") }
        setMouseHeld(current, held: false)
        let delivered = confirmedDelivery(current, since: count, expected: 2)
        guard stillActive(current) else { return foregroundRefusal("interrupted") }
        let readbackDeadline = Date().addingTimeInterval(0.25)
        var after: AXElementProbe?
        while Date() < readbackDeadline {
            guard stillActive(current), foregroundTargetReady(current) else {
                shutdown()
                return foregroundRefusal("focus_mismatch")
            }
            after = axElementProbe(axElementAtPoint(point))
            if before != nil, after != nil, before?.state != after?.state { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return inputResult("click", current, delivered: delivered, before: before, after: after,
                           extra: [["kind": "coordinate", "x": point.x, "y": point.y]])
    }

    private func safeFocusedField(_ current: ForegroundLease) -> AXUIElement? {
        guard foregroundTargetReady(current),
              let element = focusedAXElement(current.observation.pid),
              let role = axText(element, kAXRoleAttribute as String),
              role == "AXTextField" || role == "AXTextArea" else { return nil }
        var subroleValue: CFTypeRef?
        let subroleStatus = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString,
                                                           &subroleValue)
        let subrole = subroleStatus == .success ? axText(element, kAXSubroleAttribute as String) ?? "" : ""
        let unsupported: [Int32] = [-25205, -25213]
        guard subroleStatus == .success || unsupported.contains(subroleStatus.rawValue),
              !role.localizedCaseInsensitiveContains("secure"),
              !subrole.localizedCaseInsensitiveContains("secure"),
              !subrole.localizedCaseInsensitiveContains("password"),
              axText(element, kAXValueAttribute as String) != nil else { return nil }
        var protection: CFTypeRef?
        let protectionStatus = AXUIElementCopyAttributeValue(element, "AXProtectedContent" as CFString,
                                                             &protection)
        guard protectionStatus == .success || unsupported.contains(protectionStatus.rawValue) else {
            return nil
        }
        if protectionStatus == .success {
            guard (protection as? Bool) == false else { return nil }
        }
        return element
    }

    func typeText(_ params: [String: Any]) -> [String: Any] {
        let (current, code) = checkedLease(params)
        guard let current else { return foregroundRefusal(code ?? "invalid_lease") }
        guard let value = params["text"] as? String, !value.isEmpty,
              value.utf16.count <= 512, !value.utf16.contains(0) else {
            return foregroundRefusal("invalid_text")
        }
        guard let focused = safeFocusedField(current) else {
            shutdown()
            return foregroundRefusal("unsafe_focus")
        }
        let before = axText(focused, kAXValueAttribute as String) ?? ""
        let priorCount = postedCount(current)
        let units = Array(value.utf16)
        var sent = 0
        while sent < units.count {
            guard stillActive(current), foregroundTargetReady(current),
                  let sameFocused = focusedAXElement(current.observation.pid),
                  CFEqual(sameFocused, focused) else {
                endLease(code: "interrupted_or_focus_lost")
                return foregroundRefusal("interrupted_or_focus_lost")
            }
            let chunk = Array(units[sent..<min(sent + 20, units.count)])
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                return foregroundRefusal("input_unavailable")
            }
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            setKeyHeld(current, key: 0)
            defer { cleanupHeldInput(current) }
            guard post(down, current: current) else { return foregroundRefusal("interrupted") }
            guard post(up, current: current) else { return foregroundRefusal("interrupted") }
            setKeyHeld(current, key: nil)
            sent += chunk.count
        }
        let delivered = confirmedDelivery(current, since: priorCount,
                                          expected: ((units.count + 19) / 20) * 2)
        let readbackDeadline = Date().addingTimeInterval(0.5)
        var after: String?
        var exact = false
        while Date() < readbackDeadline {
            guard stillActive(current), let sameFocused = focusedAXElement(current.observation.pid),
                  CFEqual(sameFocused, focused) else {
                endLease(code: "interrupted_or_focus_lost")
                return foregroundRefusal("interrupted_or_focus_lost")
            }
            after = axText(sameFocused, kAXValueAttribute as String)
            if after == before + value || (before.isEmpty && after == value) {
                exact = true
                break
            }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return foregroundResult("type_text", effect: exact ? "confirmed" : "unknown",
                                current: current,
                                evidence: [["kind": "text_input", "utf16_length": units.count,
                                            "grapheme_length": value.count],
                                           ["kind": "text_readback", "exact": exact]],
                                delivery: delivered ? "confirmed" : "unknown",
                                application: exact ? "confirmed" : "unknown")
    }

    func keyPress(_ params: [String: Any]) -> [String: Any] {
        let (current, code) = checkedLease(params)
        guard let current else { return foregroundRefusal(code ?? "invalid_lease") }
        guard foregroundTargetReady(current) else { shutdown(); return foregroundRefusal("focus_mismatch") }
        // A key action can address a window-level shortcut. A secure field still refuses it.
        if let focused = focusedAXElement(current.observation.pid) {
            var subroleValue: CFTypeRef?
            let subroleStatus = AXUIElementCopyAttributeValue(focused, kAXSubroleAttribute as CFString,
                                                               &subroleValue)
            let role = axText(focused, kAXRoleAttribute as String) ?? ""
            let subrole = subroleStatus == .success
                ? axText(focused, kAXSubroleAttribute as String) ?? "" : ""
            let unsupported: [Int32] = [-25205, -25213]
            guard subroleStatus == .success || unsupported.contains(subroleStatus.rawValue) else {
                endLease(code: "security_state_unreadable")
                return foregroundRefusal("security_state_unreadable")
            }
            var protection: CFTypeRef?
            let protectionStatus = AXUIElementCopyAttributeValue(focused, "AXProtectedContent" as CFString,
                                                                 &protection)
            guard protectionStatus == .success || unsupported.contains(protectionStatus.rawValue) else {
                endLease(code: "security_state_unreadable")
                return foregroundRefusal("security_state_unreadable")
            }
            if role.localizedCaseInsensitiveContains("secure")
                || subrole.localizedCaseInsensitiveContains("secure")
                || subrole.localizedCaseInsensitiveContains("password")
                || (protectionStatus == .success && (protection as? Bool) == true) {
                endLease(code: "secure_field")
                return foregroundRefusal("secure_field")
            }
        }
        let keys: [String: CGKeyCode] = ["return": 36, "tab": 48, "space": 49,
                                           "delete": 51, "escape": 53, "left": 123,
                                           "right": 124, "down": 125, "up": 126]
        guard let name = params["key"] as? String, let key = keys[name] else {
            return foregroundRefusal("invalid_key")
        }
        let modifiers = params["modifiers"] as? [String] ?? []
        guard modifiers.count <= 4, Set(modifiers).count == modifiers.count,
              modifiers.allSatisfy({ ["shift", "control", "option", "command"].contains($0) }) else {
            return foregroundRefusal("invalid_modifiers")
        }
        var flags: CGEventFlags = []
        if modifiers.contains("shift") { flags.insert(.maskShift) }
        if modifiers.contains("control") { flags.insert(.maskControl) }
        if modifiers.contains("option") { flags.insert(.maskAlternate) }
        if modifiers.contains("command") { flags.insert(.maskCommand) }
        let beforeElement = focusedAXElement(current.observation.pid)
        let before = axElementProbe(beforeElement)
        let count = postedCount(current)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else {
            return foregroundRefusal("input_unavailable")
        }
        down.flags = flags
        up.flags = flags
        setKeyHeld(current, key: key)
        defer { cleanupHeldInput(current) }
        guard post(down, current: current) else { return foregroundRefusal("interrupted") }
        guard post(up, current: current) else { return foregroundRefusal("interrupted") }
        setKeyHeld(current, key: nil)
        let delivered = confirmedDelivery(current, since: count, expected: 2)
        guard stillActive(current) else { return foregroundRefusal("interrupted") }
        let readbackDeadline = Date().addingTimeInterval(0.25)
        var after: AXElementProbe?
        while Date() < readbackDeadline {
            guard stillActive(current), foregroundTargetReady(current) else {
                shutdown()
                return foregroundRefusal("focus_mismatch")
            }
            after = axElementProbe(focusedAXElement(current.observation.pid))
            if before != nil, after != nil, before?.state != after?.state { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return inputResult("key_press", current, delivered: delivered, before: before, after: after,
                           extra: [["kind": "key", "name": name, "modifiers": modifiers]])
    }

    func scroll(_ params: [String: Any]) -> [String: Any] {
        let (current, code) = checkedLease(params)
        guard let current else { return foregroundRefusal(code ?? "invalid_lease") }
        guard let point = checkedPoint(params, current) else {
            return foregroundRefusal("invalid_coordinate")
        }
        guard foregroundTargetReady(current), pointBelongsToTarget(point, current) else {
            endLease(code: "focus_mismatch")
            return foregroundRefusal("focus_mismatch")
        }
        guard let dx = (params["delta_x"] as? NSNumber)?.doubleValue,
              let dy = (params["delta_y"] as? NSNumber)?.doubleValue,
              dx.isFinite, dy.isFinite, abs(dx) <= 600, abs(dy) <= 600,
              dx != 0 || dy != 0 else { return foregroundRefusal("invalid_scroll_delta") }
        let beforeElement = axScrollIndicatorAtPoint(point)
        let before = axElementProbe(beforeElement)
        let count = postedCount(current)
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                 mouseCursorPosition: point, mouseButton: .left),
              post(move, current: current),
              let scroll = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                   wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0),
              post(scroll, current: current) else { return foregroundRefusal("interrupted") }
        let delivered = confirmedDelivery(current, since: count, expected: 2)
        guard stillActive(current) else { return foregroundRefusal("interrupted") }
        let readbackDeadline = Date().addingTimeInterval(0.3)
        var after: AXElementProbe?
        while Date() < readbackDeadline {
            guard stillActive(current), foregroundTargetReady(current) else {
                endLease(code: "focus_mismatch")
                return foregroundRefusal("focus_mismatch")
            }
            after = axElementProbe(axScrollIndicatorAtPoint(point))
            if before != nil, after != nil, before?.state != after?.state { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return inputResult("scroll", current, delivered: delivered, before: before, after: after,
                           extra: [["kind": "scroll", "delta_x": dx, "delta_y": dy]])
    }

    func drag(_ params: [String: Any]) -> [String: Any] {
        let (current, code) = checkedLease(params)
        guard let current else { return foregroundRefusal(code ?? "invalid_lease") }
        guard let start = checkedPoint(params, current, key: "start"),
              let end = checkedPoint(params, current, key: "end") else {
            return foregroundRefusal("invalid_coordinate")
        }
        guard hypot(end.x - start.x, end.y - start.y) <= 1200,
              foregroundTargetReady(current), pointBelongsToTarget(start, current),
              pointBelongsToTarget(end, current) else {
            endLease(code: "focus_mismatch")
            return foregroundRefusal("focus_mismatch")
        }
        let beforeElement = axElementAtPoint(start)
        let before = axElementProbe(beforeElement)
        let count = postedCount(current)
        setMouseHeld(current, held: true)
        defer { cleanupHeldInput(current) }
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                 mouseCursorPosition: start, mouseButton: .left),
              post(move, current: current),
              let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                 mouseCursorPosition: start, mouseButton: .left),
              post(down, current: current) else { return foregroundRefusal("interrupted") }
        for step in 1...10 {
            guard stillActive(current), foregroundTargetReady(current) else {
                return foregroundRefusal("interrupted_or_focus_lost")
            }
            let fraction = CGFloat(step) / 10
            let point = CGPoint(x: start.x + (end.x - start.x) * fraction,
                                y: start.y + (end.y - start.y) * fraction)
            guard let moved = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged,
                                      mouseCursorPosition: point, mouseButton: .left),
                  post(moved, current: current) else { return foregroundRefusal("interrupted") }
            Thread.sleep(forTimeInterval: 0.012)
        }
        guard let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                               mouseCursorPosition: end, mouseButton: .left),
              post(up, current: current) else { return foregroundRefusal("interrupted") }
        setMouseHeld(current, held: false)
        let delivered = confirmedDelivery(current, since: count, expected: 13)
        guard stillActive(current) else { return foregroundRefusal("interrupted") }
        let readbackDeadline = Date().addingTimeInterval(0.3)
        var after: AXElementProbe?
        while Date() < readbackDeadline {
            guard stillActive(current), foregroundTargetReady(current) else {
                endLease(code: "focus_mismatch")
                return foregroundRefusal("focus_mismatch")
            }
            after = axElementProbe(axElementAtPoint(start))
            if before != nil, after != nil, before?.state != after?.state { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        return inputResult("drag", current, delivered: delivered, before: before, after: after,
                           extra: [["kind": "drag", "start": ["x": start.x, "y": start.y],
                                    "end": ["x": end.x, "y": end.y]]])
    }
}
