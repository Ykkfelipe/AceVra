// ZCode CUA Probe — disposable macOS computer-use capability probe.
//
// Purpose: determine, with zero model inference, which macOS observation and
// control primitives actually work on THIS machine and which of them work
// WITHOUT activating the target application or moving the user's physical
// cursor. Every command is deterministic.
//
// Design constraints (see ../../../docs/COMPUTER_USE_ARCHITECTURE_SPIKE.md):
//   - Observation that needs no TCC permission stays separate from observation
//     that does, so the permission boundary is measurable rather than assumed.
//   - Success of an action is never inferred from an API return code. The AX
//     API reports kAXErrorSuccess for actions that did nothing (upstream
//     trycua/cua#2619), so callers must diff `state` before and after.
//   - Synthetic events this tool posts carry a private CGEventSource with a
//     known user-data tag, so a listen-only event tap can distinguish physical
//     user input from our own injected input.
//
// Build: ./build.sh   (swiftc + ad-hoc codesign, no Xcode project)

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

// MARK: - Event tagging

/// User-data tag stamped on every synthetic event this tool posts. A listen-only
/// tap can then tell our injected input apart from real hardware input.
let probeEventTag: Int64 = 0x5A43_4F44_45_0001 // "ZCODE" + 1

/// Private event source. Apple's guidance is that remote-control style tools
/// should use a private source state rather than the combined session state, so
/// our events do not masquerade as hardware.
func makeSource() -> CGEventSource? {
    let source = CGEventSource(stateID: .privateState)
    source?.userData = probeEventTag
    source?.localEventsSuppressionInterval = 0
    return source
}

// MARK: - Output helpers

/// Output sink. A bundle launched through LaunchServices (`open`) inherits no
/// useful stdout, so every command can be redirected to a file with --log —
/// that file is the only channel back from an honestly-attributed run.
var outputSink: FileHandle = FileHandle.standardOutput

func emit(_ line: String) {
    outputSink.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    outputSink.write(("error: " + message + "\n").data(using: .utf8)!)
    exit(code)
}

func jsonLine(_ object: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(
            withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]),
        let text = String(data: data, encoding: .utf8)
    else { return }
    emit(text)
}

/// Stable serialization for equality checks. Swift's `Dictionary.description`
/// does not guarantee key order, so comparing it directly reports differences
/// that do not exist.
func canonical(_ object: [String: Any]) -> String {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return "" }
    return text
}

/// Side-channel diagnostics that stay distinguishable from the JSON payload.
func note(_ line: String) {
    emit("# " + line)
}

func truncate(_ value: String, _ limit: Int = 200) -> String {
    if value.count <= limit { return value }
    return String(value.prefix(limit)) + "…(\(value.count) chars)"
}

// MARK: - Argument parsing

struct Args {
    private var flags: [String: String] = [:]
    private var present: Set<String> = []
    let positional: [String]

    init(_ raw: [String]) {
        var positional: [String] = []
        var index = 0
        while index < raw.count {
            let token = raw[index]
            if token.hasPrefix("--") {
                let name = String(token.dropFirst(2))
                if index + 1 < raw.count, !raw[index + 1].hasPrefix("--") {
                    flags[name] = raw[index + 1]
                    index += 2
                } else {
                    present.insert(name)
                    index += 1
                }
            } else {
                positional.append(token)
                index += 1
            }
        }
        self.positional = positional
    }

    func has(_ name: String) -> Bool { present.contains(name) || flags[name] != nil }
    func string(_ name: String) -> String? { flags[name] }
    func int(_ name: String) -> Int? { flags[name].flatMap { Int($0) } }
    func double(_ name: String) -> Double? { flags[name].flatMap { Double($0) } }
    func requireInt(_ name: String) -> Int {
        guard let value = int(name) else { fail("--\(name) requires an integer") }
        return value
    }
    func requireString(_ name: String) -> String {
        guard let value = string(name) else { fail("--\(name) is required") }
        return value
    }
}

// MARK: - Environment state (the evidence primitive)

func frontmostAppInfo() -> [String: Any] {
    guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
    return [
        "pid": Int(app.processIdentifier),
        "bundleId": app.bundleIdentifier ?? "",
        "name": app.localizedName ?? "",
    ]
}

func cursorLocation() -> CGPoint? {
    CGEvent(source: nil)?.location
}

/// Front-to-back list of on-screen layer-0 windows. CGWindowListCopyWindowInfo
/// needs no TCC permission — only capturing window *images* does.
func onScreenWindows(limit: Int) -> [[String: Any]] {
    guard
        let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return [] }
    var result: [[String: Any]] = []
    for window in list {
        let layer = window[kCGWindowLayer as String] as? Int ?? -1
        if layer != 0 { continue }
        result.append([
            "id": window[kCGWindowNumber as String] as? Int ?? -1,
            "pid": window[kCGWindowOwnerPID as String] as? Int ?? -1,
            "owner": window[kCGWindowOwnerName as String] as? String ?? "",
            "title": window[kCGWindowName as String] as? String ?? "",
        ])
        if result.count >= limit { break }
    }
    return result
}

func fullState() -> [String: Any] {
    let cursor = cursorLocation()
    return [
        "timestamp": ISO8601DateFormatter().string(from: Date()),
        "frontmost": frontmostAppInfo(),
        "cursor": ["x": Double(cursor?.x ?? -1), "y": Double(cursor?.y ?? -1)],
        "axTrusted": AXIsProcessTrusted(),
        "screenCapturePreflight": CGPreflightScreenCaptureAccess(),
        "topWindows": onScreenWindows(limit: 5),
        "probe": ["bundleId": Bundle.main.bundleIdentifier ?? "", "pid": Int(getpid())],
    ]
}

// MARK: - Accessibility helpers

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = axAttribute(element, name) else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func axBool(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let value = axAttribute(element, name) else { return nil }
    if let flag = value as? Bool { return flag }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

func axElementChildren(_ element: AXUIElement, includeWindows: Bool) -> [AXUIElement] {
    var children: [AXUIElement] = []
    if let value = axAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement] {
        children.append(contentsOf: value)
    }
    if includeWindows,
        let windows = axAttribute(element, kAXWindowsAttribute as String) as? [AXUIElement]
    {
        for window in windows where !children.contains(where: { CFEqual($0, window) }) {
            children.append(window)
        }
    }
    return children
}

func axPoint(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
        let list = names as? [String]
    else { return [] }
    return list
}

/// Serialize an AX value attribute without dumping unbounded text.
func axValueText(_ element: AXUIElement) -> String? {
    guard let value = axAttribute(element, kAXValueAttribute as String) else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func appElement(pid: pid_t) -> AXUIElement {
    AXUIElementCreateApplication(pid)
}

// MARK: - AX element addressing

/// Resolve an element by a dotted child-index path, e.g. `0.1.2`, starting from
/// the application element. Deterministic and stable enough for a known target.
func resolveByPath(root: AXUIElement, path: String) -> AXUIElement {
    var current = root
    for (depth, component) in path.split(separator: ".").enumerated() {
        guard let index = Int(component) else { fail("invalid path component '\(component)'") }
        let children = axElementChildren(current, includeWindows: depth == 0)
        guard index >= 0, index < children.count else {
            fail("path '\(path)' out of range at depth \(depth): \(children.count) children")
        }
        current = children[index]
    }
    return current
}

struct SearchCriteria {
    var role: String?
    var titleRegex: NSRegularExpression?
    var valueRegex: NSRegularExpression?
    var identifierRegex: NSRegularExpression?
    var descriptionRegex: NSRegularExpression?

    var isEmpty: Bool {
        role == nil && titleRegex == nil && valueRegex == nil && identifierRegex == nil
            && descriptionRegex == nil
    }

    /// Controls label themselves inconsistently: Calculator puts its label in
    /// AXDescription and its stable name in AXIdentifier, while other apps use
    /// AXTitle. All five attributes therefore have to be selectable.
    func matches(_ element: AXUIElement) -> Bool {
        if let role, axString(element, kAXRoleAttribute as String) != role { return false }
        func matchesAttribute(
            _ regex: NSRegularExpression?, _ attribute: String
        ) -> Bool {
            guard let regex else { return true }
            let text = axString(element, attribute) ?? ""
            return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
        }
        return matchesAttribute(titleRegex, kAXTitleAttribute as String)
            && matchesAttribute(valueRegex, kAXValueAttribute as String)
            && matchesAttribute(identifierRegex, kAXIdentifierAttribute as String)
            && matchesAttribute(descriptionRegex, kAXDescriptionAttribute as String)
    }
}

/// Breadth-first search for the first element matching the criteria.
func searchElement(root: AXUIElement, criteria: SearchCriteria, maxNodes: Int) -> AXUIElement? {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty, visited < maxNodes {
        let element = queue.removeFirst()
        visited += 1
        if !criteria.isEmpty, criteria.matches(element) { return element }
        queue.append(contentsOf: axElementChildren(element, includeWindows: visited == 1))
    }
    return nil
}

func compileRegex(_ pattern: String?) -> NSRegularExpression? {
    guard let pattern else { return nil }
    return try? NSRegularExpression(pattern: pattern)
}

/// Build search criteria from the shared element-addressing flags.
func criteriaFromArgs(_ args: Args) -> SearchCriteria {
    SearchCriteria(
        role: args.string("role"),
        titleRegex: compileRegex(args.string("title-regex") ?? args.string("title")),
        valueRegex: compileRegex(args.string("value-regex")),
        identifierRegex: compileRegex(args.string("identifier-regex") ?? args.string("identifier")),
        descriptionRegex: compileRegex(
            args.string("description-regex") ?? args.string("description"))
    )
}

/// Resolve the target element from either --path or the attribute criteria.
func resolveTarget(_ args: Args, pid: pid_t) -> AXUIElement {
    let root = appElement(pid: pid)
    if let path = args.string("path") {
        return resolveByPath(root: root, path: path)
    }
    let criteria = criteriaFromArgs(args)
    guard !criteria.isEmpty else {
        fail(
            "provide either --path or at least one of --role/--title/--value-regex/--identifier-regex/--description-regex"
        )
    }
    guard
        let found = searchElement(
            root: root, criteria: criteria, maxNodes: args.int("max-nodes") ?? 4000)
    else {
        fail("no accessibility element matched the criteria")
    }
    return found
}

func describeElement(_ element: AXUIElement) -> [String: Any] {
    var info: [String: Any] = [:]
    for (key, attribute) in [
        ("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute),
        ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute),
        ("identifier", kAXIdentifierAttribute), ("help", kAXHelpAttribute),
    ] {
        if let value = axString(element, attribute as String) { info[key] = value }
    }
    if let value = axValueText(element) { info["value"] = truncate(value) }
    if let enabled = axBool(element, kAXEnabledAttribute as String) { info["enabled"] = enabled }
    if let point = axPoint(element, kAXPositionAttribute as String) {
        info["position"] = ["x": Double(point.x), "y": Double(point.y)]
    }
    if let size = axSize(element, kAXSizeAttribute as String) {
        info["size"] = ["w": Double(size.width), "h": Double(size.height)]
    }
    let actions = axActionNames(element)
    if !actions.isEmpty { info["actions"] = actions }
    return info
}

// MARK: - Commands: permissions

func commandPermissions(_ args: Args) {
    let bundleId = Bundle.main.bundleIdentifier ?? "(none)"
    emit("probe.bundleId=\(bundleId)")
    emit("probe.executable=\(Bundle.main.executablePath ?? "(unknown)")")
    emit("probe.pid=\(getpid())")
    emit("probe.parentPid=\(getppid())")

    var trusted = AXIsProcessTrusted()
    var capture = CGPreflightScreenCaptureAccess()
    emit("accessibility.trusted=\(trusted)")
    emit("screenRecording.preflight=\(capture)")

    if args.has("request") {
        // Both calls are asynchronous: they register the app in the relevant
        // System Settings list and show the system prompt, then the user has to
        // toggle it on. Nothing here grants permission by itself.
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
        trusted = AXIsProcessTrustedWithOptions(options as CFDictionary)
        capture = CGRequestScreenCaptureAccess()
        emit("accessibility.trustedAfterPromptRequest=\(trusted)")
        emit("screenRecording.afterPromptRequest=\(capture)")
        emit("note=pending user approval in System Settings; relaunch required after granting screen recording")
    }
}

// MARK: - Commands: observation

func commandApps(_ args: Args) {
    let apps = NSWorkspace.shared.runningApplications
    let filtered = args.has("all") ? apps : apps.filter { $0.activationPolicy == .regular }
    for app in filtered.sorted(by: { $0.processIdentifier < $1.processIdentifier }) {
        jsonLine([
            "pid": Int(app.processIdentifier),
            "bundleId": app.bundleIdentifier ?? "",
            "name": app.localizedName ?? "",
            "policy": app.activationPolicy == .regular
                ? "regular" : (app.activationPolicy == .accessory ? "accessory" : "prohibited"),
            "active": app.isActive,
            "hidden": app.isHidden,
        ])
    }
}

func commandWindows(_ args: Args) {
    var options: CGWindowListOption = [.excludeDesktopElements]
    if !args.has("all") { options.insert(.optionOnScreenOnly) }
    guard
        let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
    else { fail("CGWindowListCopyWindowInfo returned nothing") }

    let pidFilter = args.int("pid")
    var zOrder = 0
    for window in list {
        let layer = window[kCGWindowLayer as String] as? Int ?? -1
        let pid = window[kCGWindowOwnerPID as String] as? Int ?? -1
        if let pidFilter, pid != pidFilter { continue }
        var bounds: [String: Double] = [:]
        if let dict = window[kCGWindowBounds as String] as? [String: Any],
            let rect = CGRect(dictionaryRepresentation: dict as CFDictionary)
        {
            bounds = [
                "x": Double(rect.origin.x), "y": Double(rect.origin.y),
                "w": Double(rect.width), "h": Double(rect.height),
            ]
        }
        jsonLine([
            "id": window[kCGWindowNumber as String] as? Int ?? -1,
            "pid": pid,
            "owner": window[kCGWindowOwnerName as String] as? String ?? "",
            "title": window[kCGWindowName as String] as? String ?? "",
            "layer": layer,
            "onScreen": window[kCGWindowIsOnscreen as String] as? Bool ?? false,
            "zOrder": zOrder,
            "bounds": bounds,
        ])
        zOrder += 1
    }
}

func commandAxTree(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let maxDepth = args.int("max-depth") ?? 6
    let maxNodes = args.int("max-nodes") ?? 800
    var nodes = 0

    func walk(_ element: AXUIElement, depth: Int) {
        guard nodes < maxNodes else { return }
        nodes += 1
        let info = describeElement(element)
        let role = info["role"] as? String ?? "?"
        let title = info["title"] as? String ?? ""
        let value = info["value"] as? String ?? ""
        let identifier = info["identifier"] as? String ?? ""
        var line = String(repeating: "  ", count: depth) + role
        if !title.isEmpty { line += " title=\(truncate(title, 60))" }
        if !value.isEmpty { line += " value=\(truncate(value, 60))" }
        if !identifier.isEmpty { line += " id=\(identifier)" }
        if let enabled = info["enabled"] as? Bool, !enabled { line += " [disabled]" }
        if let actions = info["actions"] as? [String], !actions.isEmpty {
            line += " actions=\(actions.joined(separator: ","))"
        }
        emit(line)
        guard depth < maxDepth else { return }
        for child in axElementChildren(element, includeWindows: depth == 0) {
            walk(child, depth: depth + 1)
            if nodes >= maxNodes { return }
        }
    }

    walk(appElement(pid: pid), depth: 0)
    note("nodes=\(nodes)")
}

func commandAxElements(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let maxNodes = args.int("max-nodes") ?? 4000
    let criteria = criteriaFromArgs(args)
    var queue: [AXUIElement] = [appElement(pid: pid)]
    var visited = 0
    while !queue.isEmpty, visited < maxNodes {
        let element = queue.removeFirst()
        visited += 1
        if criteria.isEmpty || criteria.matches(element) {
            var info = describeElement(element)
            info["index"] = visited
            jsonLine(info)
        }
        queue.append(contentsOf: axElementChildren(element, includeWindows: visited == 1))
    }
    note("nodes=\(visited)")
}

func commandAxGet(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let element = resolveTarget(args, pid: pid)
    var info = describeElement(element)
    if let attribute = args.string("attribute"), let value = axString(element, attribute) {
        info["attributeValue"] = value
    }
    jsonLine(info)
}

// MARK: - Commands: semantic actions

func commandAxPress(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let element = resolveTarget(args, pid: pid)
    let action = args.string("action") ?? (kAXPressAction as String)

    let before = describeElement(element)
    let started = Date()
    let result = AXUIElementPerformAction(element, action as CFString)
    let elapsed = Date().timeIntervalSince(started) * 1000
    let after = describeElement(element)

    jsonLine([
        "action": action,
        "axError": result.rawValue,
        "axErrorName": result == .success ? "success" : "\(result.rawValue)",
        // elementChanged only reports whether THIS element's own attributes
        // moved. A stateless button legitimately reports false after a press
        // that worked, so it is never sufficient evidence on its own: the caller
        // has to verify the resulting application state (see run-tests.sh, which
        // reads Calculator's display value instead).
        "elementChanged": canonical(before) != canonical(after),
        "axSuccessIsNotProof": true,
        "before": before,
        "after": after,
        "latencyMs": elapsed,
    ])
}

func commandAxSetValue(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let value = args.requireString("value")
    let element = resolveTarget(args, pid: pid)
    let attribute = args.string("attribute") ?? (kAXValueAttribute as String)

    let before = axValueText(element)
    let started = Date()
    let result = AXUIElementSetAttributeValue(element, attribute as CFString, value as CFString)
    let elapsed = Date().timeIntervalSince(started) * 1000
    let after = axValueText(element)

    jsonLine([
        "attribute": attribute,
        "requested": value,
        "axError": result.rawValue,
        "before": before ?? "",
        "after": after ?? "",
        // Read-back is the only proof: a set that returns .success but leaves
        // the value unchanged is a silent no-op.
        "changed": before != after,
        "readbackMatches": after == value,
        "latencyMs": elapsed,
    ])
}

func commandAxFocus(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let element = resolveTarget(args, pid: pid)
    let before = axBool(element, kAXFocusedAttribute as String)
    let set = AXUIElementSetAttributeValue(
        element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let after = axBool(element, kAXFocusedAttribute as String)
    jsonLine([
        "setError": set.rawValue,
        "beforeFocused": before ?? false,
        "afterFocused": after ?? false,
        "changed": before != after,
    ])
}

// MARK: - Commands: capture

@available(macOS 14.0, *)
func writePNG(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fail("could not create PNG destination at \(path)") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("could not write PNG to \(path)") }
}

@available(macOS 14.0, *)
func commandShot(_ args: Args) {
    // ScreenCaptureKit talks to the window server, which requires the process to
    // have established a GUI connection first; without this the CGS layer
    // asserts (CGS_REQUIRE_INIT) before any capture is attempted.
    _ = NSApplication.shared
    let outPath = args.string("out") ?? "shot.png"
    let windowID = args.int("window")
    let started = Date()

    // ScreenCaptureKit reports on its own queue, so the main thread has to keep
    // a run loop turning while it waits. Blocking the main thread on a semaphore
    // instead would starve the callback.
    var finished: [String: Any]?
    func finish(_ result: [String: Any]) {
        DispatchQueue.main.async {
            finished = result
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }

    SCShareableContent.getExcludingDesktopWindows(
        args.has("include-desktop-elements"), onScreenWindowsOnly: !args.has("all-windows")
    ) { content, error in
        guard let content else {
            finish([
                "ok": false,
                "error": "shareableContent: \(error?.localizedDescription ?? "unknown")",
            ])
            return
        }
        let filter: SCContentFilter
        var label: String
        var metadata: [String: Any] = [:]
        if let windowID {
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                finish([
                    "ok": false,
                    "error": "window \(windowID) absent from shareable content",
                    "availableWindowIds": content.windows.map { Int($0.windowID) },
                ])
                return
            }
            // Captures the window's own contents, independent of z-order — this
            // is what makes capture of an occluded window possible at all.
            filter = SCContentFilter(desktopIndependentWindow: window)
            label = "window:\(windowID)"
            metadata["windowFrame"] = [
                "x": Double(window.frame.origin.x), "y": Double(window.frame.origin.y),
                "w": Double(window.frame.width), "h": Double(window.frame.height),
            ]
            metadata["owningApp"] = window.owningApplication?.applicationName ?? ""
            metadata["isOnScreen"] = window.isOnScreen
        } else {
            guard let display = content.displays.first else {
                finish(["ok": false, "error": "no displays in shareable content"])
                return
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            label = "display:\(display.displayID)"
            metadata["displayId"] = Int(display.displayID)
        }

        let configuration = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = Int(filter.contentRect.width * scale)
        configuration.height = Int(filter.contentRect.height * scale)
        configuration.showsCursor = false
        configuration.capturesAudio = false

        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) {
            image, captureError in
            guard let image else {
                finish([
                    "ok": false,
                    "error": "captureImage: \(captureError?.localizedDescription ?? "unknown")",
                ])
                return
            }
            writePNG(image, to: outPath)
            var result = metadata
            result["ok"] = true
            result["target"] = label
            result["out"] = outPath
            result["width"] = image.width
            result["height"] = image.height
            result["scale"] = Double(scale)
            result["latencyMs"] = Date().timeIntervalSince(started) * 1000
            finish(result)
        }
    }

    let deadline = Date().addingTimeInterval(20)
    while finished == nil, Date() < deadline {
        CFRunLoopRunInMode(.defaultMode, 0.05, false)
    }
    guard let result = finished else {
        fail(
            "screen capture timed out after 20s (missing screen recording permission, or the granting app was not relaunched afterwards)"
        )
    }
    jsonLine(result)
    if (result["ok"] as? Bool) != true { exit(1) }
}

/// Verify a capture holds real content. A denied or blanked screen-recording
/// capture still produces a valid PNG of the right dimensions, so file size and
/// dimensions prove nothing — pixel variance does.
func commandPngStats(_ args: Args) {
    let path = args.requireString("png")
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { fail("could not read PNG at \(path)") }

    let width = image.width
    let height = image.height
    let bytesPerPixel = 4
    var buffer = [UInt8](repeating: 0, count: width * height * bytesPerPixel)
    guard
        let context = CGContext(
            data: &buffer, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * bytesPerPixel, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fail("could not create bitmap context") }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    var sums = [Double](repeating: 0, count: 3)
    var squares = [Double](repeating: 0, count: 3)
    var unique = Set<UInt32>()
    for offset in stride(from: 0, to: buffer.count, by: bytesPerPixel) {
        for channel in 0..<3 {
            let value = Double(buffer[offset + channel])
            sums[channel] += value
            squares[channel] += value * value
        }
        if unique.count < 250_000 {
            unique.insert(
                UInt32(buffer[offset]) << 16 | UInt32(buffer[offset + 1]) << 8
                    | UInt32(buffer[offset + 2]))
        }
    }
    let pixelCount = Double(width * height)
    func deviation(_ channel: Int) -> Double {
        let mean = sums[channel] / pixelCount
        return max(0, squares[channel] / pixelCount - mean * mean).squareRoot()
    }
    let deviations = (0..<3).map(deviation)
    jsonLine([
        "path": path, "width": width, "height": height,
        "meanR": sums[0] / pixelCount, "meanG": sums[1] / pixelCount, "meanB": sums[2] / pixelCount,
        "stdR": deviations[0], "stdG": deviations[1], "stdB": deviations[2],
        "uniqueColorsSampled": unique.count,
        "looksBlank": deviations.allSatisfy { $0 < 1.0 },
    ])
}

// MARK: - Commands: input synthesis

/// Deliver an event to one process only. This is the only public API that
/// injects input without repositioning the hardware cursor, and it is
/// process-scoped rather than window-scoped — the target app decides whether to
/// honour it.
func postToPid(_ pid: pid_t, _ event: CGEvent) {
    event.postToPid(pid)
}

func commandPidKey(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let source = makeSource()
    let modifiers = parseModifiers(args.string("modifiers"))
    let started = Date()

    if let text = args.string("text") {
        // Unicode payload on a keyDown/keyUp pair, PID-scoped.
        for isDown in [true, false] {
            guard
                let event = CGEvent(
                    keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
            else { fail("could not create keyboard event") }
            var units = Array(text.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            if let modifiers { event.flags = modifiers }
            postToPid(pid, event)
        }
        jsonLine([
            "ok": true, "kind": "text", "text": truncate(text), "pid": Int(pid),
            "route": "CGEventPostToPid",
            "latencyMs": Date().timeIntervalSince(started) * 1000,
        ])
        return
    }

    let keyCode = CGKeyCode(args.requireInt("keycode"))
    for isDown in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: isDown)
        else { fail("could not create keyboard event") }
        if let modifiers { event.flags = modifiers }
        postToPid(pid, event)
    }
    jsonLine([
        "ok": true, "kind": "key", "keycode": Int(keyCode), "pid": Int(pid),
        "modifiers": args.string("modifiers") ?? "", "route": "CGEventPostToPid",
        "latencyMs": Date().timeIntervalSince(started) * 1000,
    ])
}

func commandPidClick(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let x = Double(args.requireInt("x"))
    let y = Double(args.requireInt("y"))
    let button = args.string("button") ?? "left"
    let point = CGPoint(x: x, y: y)
    let source = makeSource()
    let started = Date()

    let (downType, upType): (CGEventType, CGEventType) =
        button == "right" ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
    let (downButton, upButton): (CGMouseButton, CGMouseButton) =
        button == "right" ? (.right, .right) : (.left, .left)

    guard
        let down = CGEvent(
            mouseEventSource: source, mouseType: downType, mouseCursorPosition: point,
            mouseButton: downButton),
        let up = CGEvent(
            mouseEventSource: source, mouseType: upType, mouseCursorPosition: point,
            mouseButton: upButton)
    else { fail("could not create mouse event") }

    // The click count/window field is set before posting so the target app sees
    // a click scoped to itself rather than a global one.
    down.setIntegerValueField(.mouseEventClickState, value: 1)
    up.setIntegerValueField(.mouseEventClickState, value: 1)

    postToPid(pid, down)
    postToPid(pid, up)

    jsonLine([
        "ok": true, "kind": "click", "button": button, "pid": Int(pid),
        "x": x, "y": y, "route": "CGEventPostToPid",
        "latencyMs": Date().timeIntervalSince(started) * 1000,
    ])
}

func commandPidScroll(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    let delta = Int32(args.requireInt("delta"))
    let source = makeSource()
    guard
        let event = CGEvent(
            scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: delta,
            wheel2: 0, wheel3: 0)
    else { fail("could not create scroll event") }
    postToPid(pid, event)
    jsonLine(["ok": true, "kind": "scroll", "delta": Int(delta), "pid": Int(pid), "route": "CGEventPostToPid"])
}

func commandGlobalClick(_ args: Args) {
    let x = Double(args.requireInt("x"))
    let y = Double(args.requireInt("y"))
    let button = args.string("button") ?? "left"
    let point = CGPoint(x: x, y: y)
    let source = makeSource()

    // Warping first is not optional. Posting a mouse event whose location field
    // points somewhere else does NOT move the hardware cursor, and the click is
    // routed using the actual pointer position — so without the warp the click
    // lands wherever the pointer already happened to be. This is the step that
    // makes a global click genuinely foreground.
    if !args.has("no-warp") {
        CGWarpMouseCursorPosition(point)
        CGAssociateMouseAndMouseCursorPosition(1)
        // Give the window server a moment to settle on the new location before
        // the button events reference it.
        usleep(60_000)
    }

    let (downType, upType): (CGEventType, CGEventType) =
        button == "right" ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
    let (downButton, upButton): (CGMouseButton, CGMouseButton) =
        button == "right" ? (.right, .right) : (.left, .left)
    guard
        let down = CGEvent(
            mouseEventSource: source, mouseType: downType, mouseCursorPosition: point,
            mouseButton: downButton),
        let up = CGEvent(
            mouseEventSource: source, mouseType: upType, mouseCursorPosition: point,
            mouseButton: upButton)
    else { fail("could not create mouse event") }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)

    let after = cursorLocation()
    jsonLine([
        "ok": true, "kind": "global-click", "button": button, "x": x, "y": y,
        "route": "CGEventPost(cghidEventTap)",
        "warped": !args.has("no-warp"),
        "cursorAfter": ["x": Double(after?.x ?? -1), "y": Double(after?.y ?? -1)],
    ])
}

func commandHotkey(_ args: Args) {
    let keyCode = CGKeyCode(args.requireInt("keycode"))
    guard let modifiers = parseModifiers(args.string("modifiers")) else {
        fail("--modifiers is required, e.g. --modifiers cmd,shift")
    }
    let source = makeSource()
    for isDown in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: isDown)
        else { fail("could not create keyboard event") }
        event.flags = modifiers
        event.post(tap: .cghidEventTap)
    }
    jsonLine(["ok": true, "kind": "hotkey", "keycode": Int(keyCode), "route": "CGEventPost(cghidEventTap)"])
}

func commandTypeGlobal(_ args: Args) {
    let text = args.requireString("text")
    let source = makeSource()
    for isDown in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
        else { fail("could not create keyboard event") }
        var units = Array(text.utf16)
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        event.post(tap: .cghidEventTap)
    }
    jsonLine(["ok": true, "kind": "global-text", "text": truncate(text), "route": "CGEventPost(cghidEventTap)"])
}

func commandMoveCursor(_ args: Args) {
    let x = Double(args.requireInt("x"))
    let y = Double(args.requireInt("y"))
    CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    // Without this the cursor stays disassociated from the mouse for a moment,
    // which distorts the next real mouse movement.
    CGAssociateMouseAndMouseCursorPosition(1)
    let after = cursorLocation()
    jsonLine(["ok": true, "x": Double(after?.x ?? -1), "y": Double(after?.y ?? -1), "route": "CGWarpMouseCursorPosition"])
}

func parseModifiers(_ raw: String?) -> CGEventFlags? {
    guard let raw, !raw.isEmpty else { return nil }
    var flags: CGEventFlags = []
    for token in raw.split(separator: ",") {
        switch token.trimmingCharacters(in: .whitespaces).lowercased() {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: fail("unknown modifier '\(token)'")
        }
    }
    return flags
}

/// Activate an application the honest way (used by the foreground tests).
func commandActivate(_ args: Args) {
    let pid = pid_t(args.requireInt("pid"))
    guard let app = NSRunningApplication(processIdentifier: pid) else {
        fail("no running application with pid \(pid)")
    }
    let started = Date()
    let ok = app.activate(options: [])
    jsonLine([
        "ok": ok, "pid": Int(pid), "name": app.localizedName ?? "",
        "latencyMs": Date().timeIntervalSince(started) * 1000,
    ])
}

// MARK: - Commands: user-interruption detection (Test E)

final class TapCounters {
    static let shared = TapCounters()
    var physical = 0
    var synthetic = 0
    var physicalByType: [String: Int] = [:]
    var disabledBySystem = 0
    var tap: CFMachPort?
}

func commandWatch(_ args: Args) {
    let seconds = args.double("seconds") ?? 5
    // Built incrementally: a single ten-term `|` chain of these conversions
    // exceeds the Swift type checker's budget and fails to compile.
    var mask: CGEventMask = 0
    let watchedTypes: [CGEventType] = [
        .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
        .keyDown, .keyUp, .flagsChanged,
        .mouseMoved, .leftMouseDragged, .scrollWheel,
    ]
    for type in watchedTypes {
        mask |= CGEventMask(1) << CGEventMask(type.rawValue)
    }

    let callback: CGEventTapCallBack = { _, type, event, _ in
        // macOS disables a tap that takes too long or when input arrives while
        // it is busy. An interruption monitor that stays silently dead after
        // that is worse than none, so re-enable instead of ignoring it.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            TapCounters.shared.disabledBySystem += 1
            if let tap = TapCounters.shared.tap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }

        // A listen-only tap only sees events that reach the global chain, and
        // PID-routed events bypass that chain. Anything our own injected events
        // do produce is still identifiable by the user-data tag we stamp.
        let tag = event.getIntegerValueField(.eventSourceUserData)
        if tag == probeEventTag {
            TapCounters.shared.synthetic += 1
        } else {
            TapCounters.shared.physical += 1
            TapCounters.shared.physicalByType["\(type.rawValue)", default: 0] += 1
        }
        return Unmanaged.passUnretained(event)
    }

    guard
        let tap = CGEvent.tapCreate(
            tap: .cghidEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: mask, callback: callback, userInfo: nil)
    else {
        jsonLine([
            "ok": false,
            "error": "CGEventTapCreate returned nil",
            "interpretation": "listen-only taps require Accessibility (or Input Monitoring) permission for this process",
        ])
        exit(1)
    }

    TapCounters.shared.tap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)

    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        let remaining = deadline.timeIntervalSinceNow
        if remaining <= 0 { break }
        CFRunLoopRunInMode(.defaultMode, min(remaining, 0.25), false)
    }

    CGEvent.tapEnable(tap: tap, enable: false)
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)

    jsonLine([
        "ok": true,
        "seconds": seconds,
        "physicalEvents": TapCounters.shared.physical,
        "syntheticEvents": TapCounters.shared.synthetic,
        "physicalByType": TapCounters.shared.physicalByType,
        "tapDisabledBySystem": TapCounters.shared.disabledBySystem,
        "axTrusted": AXIsProcessTrusted(),
    ])
}

// MARK: - Dispatch

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else {
    emit(
        """
        ZCode CUA Probe — deterministic macOS computer-use capability probe.

        Observation:
          permissions [--request]
          state
          apps [--all]
          windows [--all] [--pid P]
          ax-tree --pid P [--max-depth N] [--max-nodes N]
          ax-elements --pid P [--role R] [--title-regex RX] [--value-regex RX]
                      [--identifier-regex RX] [--description-regex RX]
          ax-get --pid P [--path a.b.c | --role R --title T] [--attribute AXAttr]

        Semantic actions (Accessibility):
          ax-press     --pid P [--path a.b.c | --role R --identifier-regex RX] [--action AXPress]
          ax-set-value --pid P [--path ... | --description-regex RX] --value V
          ax-focus     --pid P [--path ... | --identifier-regex RX]

        Capture:
          shot --window ID --out PATH
          shot --display --out PATH
          png-stats --png PATH

        Background input (PID-scoped):
          pid-key    --pid P (--text T | --keycode N) [--modifiers cmd,shift]
          pid-click  --pid P --x X --y Y [--button left|right]
          pid-scroll --pid P --delta N

        Foreground input (global HID — moves the cursor):
          global-click --x X --y Y [--button left|right]
          hotkey --keycode N --modifiers cmd,shift
          type-global --text T
          move-cursor --x X --y Y
          activate --pid P

        User interruption:
          watch --seconds S

        Every command also accepts --log PATH to append its output to a file,
        which is how a LaunchServices-launched bundle reports results.
        """)
    exit(2)
}

let args = Args(Array(argv.dropFirst()))

// Optional file sink. Needed when the bundle is launched via `open`, where
// stdout goes nowhere we can read.
if let logPath = args.string("log") {
    let url = URL(fileURLWithPath: logPath)
    try? FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: logPath) {
        FileManager.default.createFile(atPath: logPath, contents: nil)
    }
    guard let handle = FileHandle(forWritingAtPath: logPath) else {
        fail("could not open log file at \(logPath)")
    }
    handle.seekToEndOfFile()
    outputSink = handle
}

switch command {
case "permissions": commandPermissions(args)
case "state": jsonLine(fullState())
case "apps": commandApps(args)
case "windows": commandWindows(args)
case "ax-tree": commandAxTree(args)
case "ax-elements": commandAxElements(args)
case "ax-get": commandAxGet(args)
case "ax-press": commandAxPress(args)
case "ax-set-value": commandAxSetValue(args)
case "ax-focus": commandAxFocus(args)
case "shot":
    if #available(macOS 14.0, *) { commandShot(args) } else { fail("screen capture requires macOS 14+") }
case "png-stats": commandPngStats(args)
case "pid-key": commandPidKey(args)
case "pid-click": commandPidClick(args)
case "pid-scroll": commandPidScroll(args)
case "global-click": commandGlobalClick(args)
case "hotkey": commandHotkey(args)
case "type-global": commandTypeGlobal(args)
case "move-cursor": commandMoveCursor(args)
case "activate": commandActivate(args)
case "watch": commandWatch(args)
default: fail("unknown command '\(command)' (run with no arguments for usage)", code: 2)
}
