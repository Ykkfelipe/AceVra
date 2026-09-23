// CUA-1 observe-only methods served over the broker socket.
//
// Scope: observation only. Nothing in this file synthesises input — there is no AX action,
// no keystroke and no pointer event — and there is no window mutation. The four methods are
// the ones the CUA-1 brief names: `permission_status`, `list_apps`, `list_windows`, `observe`.
//
// Every result carries the envelope §7 of the spike made mandatory (`route`,
// `delivery.mode`, `effect`, `evidence`), and the mapping is deliberately conservative:
// observation has no actuator, so `confirmed` requires a readback that proves something was
// actually read, a half-success is `partial`, and a refusal is `refused`. `unverifiable`
// belongs to the input rungs CUA-2+ will add and must not appear here.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// The methods this helper serves. Everything else is refused at the native dispatch boundary.
let supportedBrokerMethods: Set<String> = [
    "permission_status", "list_apps", "list_windows", "observe", "press", "set_value",
]

// MARK: - Observation bounds

/// Hard caps on what one observation may return.
///
/// These are ceilings, not defaults: a caller-supplied `max_elements` is clamped *down* to them,
/// so a request cannot ask for an unbounded tree dump (or an unbounded amount of memory) and a
/// malformed or hostile parameter cannot either. The client applies the same ceilings again in
/// `packages/zcode-cua/observe-result.js`, because the helper is not the only thing that can put
/// bytes in front of a model.
enum ObservationLimits {
    static let maxElementsCeiling = 2000
    static let maxElementsDefault = 1500
    static let maxDepthCeiling = 40
    static let maxDepthDefault = 25
    /// Per-string ceiling for AX text. A text field's value can be megabytes (a document, a log
    /// buffer); the observation contract is a summary of the UI, not a file transfer.
    static let maxStringCharacters = 512
    /// Ceiling on the action-name list of a single element.
    static let maxActionsPerElement = 32
    /// Windows in one `list_windows` response.
    static let maxWindowsCeiling = 500
    static let maxWindowsDefault = 200
}

func clamped(_ value: Int?, _ fallback: Int, _ ceiling: Int) -> Int {
    guard let value else { return fallback }
    return max(0, min(value, ceiling))
}

// MARK: - Envelope

/// Every result carries the identity the helper verified for itself. It travels with the payload
/// rather than on a separate handshake so a caller validates the identity of the process that
/// produced *this* answer, not the identity of whatever answered an earlier question.
func brokerEnvelope(route: String, effect: String, evidence: [[String: Any]] = []) -> [String: Any] {
    [
        "route": route,
        // Observation never fronts, raises or focuses anything.
        "delivery": ["mode": "background"],
        "effect": effect,
        "evidence": evidence,
        "helper_identity": shortIdentityJSON(helperSelfIdentity),
    ]
}

// MARK: - permission_status

/// Grants as this Helper's own process sees them.
///
/// `stale` is deliberately never reported: it is not derivable from a preflight call (measured
/// in the identity foundation), so the permission owner computes it from remembered prior-grant
/// state. Reporting it here would be inventing an OS signal.
///
/// The Screen Recording fields are split on purpose. `screen_recording` / `screen_recording_
/// readout.preflight` is a *cached process readout*: `CGPreflightScreenCaptureAccess` answers
/// from a value this process cached the first time it was called, so it stays `false` for a
/// process that asked before the user granted and stays `true` for one that asked before the
/// user revoked. The *functional* truth is a real capture, which `observe` performs;
/// `screen_capture_probe_state` says whether that has happened here (`not_run`), so a `false`
/// probe value can never be read as "Screen Recording denied".
func permissionStatusResult(peer: CodeIdentityReport? = nil) -> [String: Any] {
    let accessibility = AXIsProcessTrusted()
    let preflight = CGPreflightScreenCaptureAccess()
    let identity = helperSelfIdentity
    // Only a verified signature may name the grant owner. `grant_owner` is what the settings UI
    // shows the user so they can find the right row in System Settings, so pointing it at an
    // unverified process would send them to a row that does not govern this binary.
    let grantOwner = identity.verified ? identity.identifier : ""
    var result: [String: Any] = [
        "available": true,
        "platform": "darwin",
        "grant_owner": grantOwner,
        "owner": [
            "display_name": grantOwner.isEmpty
                ? "unverified helper" : grantOwner
        ],
        "accessibility": accessibility ? "granted" : "denied",
        "accessibility_probe_ok": accessibility,
        "screen_recording": preflight ? "granted" : "denied",
        "screen_recording_readout": [
            "preflight": preflight,
            "source": "CGPreflightScreenCaptureAccess",
            "cached": true,
            "note":
                "process-cached readout, not the functional truth; a real capture decides "
                + "whether Screen Recording actually works",
        ],
        // The functional probe is `observe`; `permission_status` never runs a capture, so it
        // reports "not run" instead of a `false` that would read as a denial.
        "screen_capture_probe_ok": NSNull(),
        "screen_capture_probe_state": "not_run",
        "screen_capture_probe_source": "none",
        "identity": identity.json,
        "identity_verified": identity.verified,
    ]
    // Who asked. Reported rather than assumed: the pid comes from the kernel and the identity from
    // that process's signature, so a launcher can see whether the caller it expected is the caller
    // it got. Enforcement only applies when the launcher configured an expected caller.
    if let peer {
        result["caller_identity"] = peer.json
        result["caller_required"] = !cuaIdentityPolicy.requiredPeerIdentifier.isEmpty
            || cuaIdentityPolicy.requireSignedPeer
    }
    result.merge(brokerEnvelope(route: "none", effect: "confirmed")) { current, _ in current }
    return result
}

// MARK: - list_apps

/// Running applications. Requires no TCC grant, and must never be gated on one.
func listAppsResult() -> [String: Any] {
    let regular = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular
    }
    // An app that is launching or terminating reports pid -1 (unknown). Emitting that would
    // hand the caller an unusable address, so those are skipped and counted instead.
    let apps = regular
        .filter { $0.processIdentifier > 0 }
        .compactMap { app -> [String: Any]? in
            guard let bundleId = app.bundleIdentifier else { return nil }
            return [
                "pid": Int(app.processIdentifier),
                "bundle_id": bundleId,
                "name": app.localizedName ?? "",
                "active": app.isActive,
                "hidden": app.isHidden,
            ]
        }
    var result: [String: Any] = ["apps": apps, "count": apps.count]
    let skipped = regular.count - apps.count
    if skipped > 0 {
        result["skipped"] = skipped
        result["skipped_note"] = "regular apps without a usable pid (launching or terminating)"
    }
    result.merge(
        brokerEnvelope(
            route: "workspace", effect: "confirmed",
            evidence: [["kind": "value_readback", "source": "NSWorkspace", "count": apps.count]]))
    { current, _ in current }
    return result
}

// MARK: - list_windows

/// Layer-0 windows, most recently on-screen first.
///
/// Deliberately NOT filtered to on-screen windows. Measured on macOS 27: `kCGWindowIsOnscreen`
/// is false for almost every application window (136 of 137 on this machine, including windows
/// that were plainly visible), so a `optionOnScreenOnly` list returned 1 usable window where the
/// user actually had 7. The flag is reported per window instead, and the caller decides.
///
/// Degenerate entries are dropped: the window server's own bookkeeping windows report a zero or
/// near-zero size, and services such as CursorUIViewService publish 64x64 stubs that are not
/// windows anyone can act on.
func listWindowsResult(params: [String: Any] = [:]) -> [String: Any] {
    let maxWindows = clamped(
        (params["max_windows"] as? NSNumber)?.intValue, ObservationLimits.maxWindowsDefault,
        ObservationLimits.maxWindowsCeiling)
    let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    var windows: [[String: Any]] = []
    for (zOrder, window) in raw.enumerated() {
        let layer = window[kCGWindowLayer as String] as? Int ?? -1
        if layer != 0 { continue }
        let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        let width = Double(bounds["Width"] ?? 0)
        let height = Double(bounds["Height"] ?? 0)
        let title = window[kCGWindowName as String] as? String ?? ""
        // A window with no title and no usable area is bookkeeping, not a target.
        if width < 40 || height < 40 { continue }
        windows.append([
            "window_id": window[kCGWindowNumber as String] as? Int ?? -1,
            "pid": window[kCGWindowOwnerPID as String] as? Int ?? -1,
            "owner": window[kCGWindowOwnerName as String] as? String ?? "",
            "title": title,
            "z_order": zOrder,
            "on_screen": (window[kCGWindowIsOnscreen as String] as? Bool) ?? false,
            "bounds": [
                "x": Double(bounds["X"] ?? 0),
                "y": Double(bounds["Y"] ?? 0),
                "w": width,
                "h": height,
            ] as [String: Double],
        ])
    }
    windows.sort { left, right in
        let leftOnScreen = (left["on_screen"] as? Bool) ?? false
        let rightOnScreen = (right["on_screen"] as? Bool) ?? false
        if leftOnScreen != rightOnScreen { return leftOnScreen }
        return ((left["z_order"] as? Int) ?? 0) < ((right["z_order"] as? Int) ?? 0)
    }
    let truncated = windows.count > maxWindows
    if truncated { windows = Array(windows.prefix(maxWindows)) }

    let titled = windows.filter { !(($0["title"] as? String) ?? "").isEmpty }.count
    var result: [String: Any] = [
        "windows": windows,
        "count": windows.count,
        "titled_count": titled,
        "truncated": truncated,
        "on_screen_note":
            "macOS 27 reports kCGWindowIsOnscreen false for most application windows; "
            + "use the per-window on_screen flag rather than assuming only listed windows exist",
    ]
    if titled < windows.count {
        result["titles_note"] =
            "untitled entries are windows whose title is empty; without Screen Recording every "
            + "title is empty"
    }
    result.merge(
        brokerEnvelope(
            route: "windowserver", effect: "confirmed",
            evidence: [["kind": "value_readback", "source": "CGWindowList", "count": windows.count]]))
    { current, _ in current }
    return result
}

// MARK: - observe

/// One window: a ScreenCaptureKit capture and/or the Accessibility tree.
///
/// The two rungs are independent, so a missing grant degrades the result instead of failing the
/// call: whichever rung succeeded is returned, and every rung that did not is named in `error`
/// and in `evidence`. Effect is `confirmed` only when both requested rungs succeeded.
func observeResult(params: [String: Any]) -> [String: Any] {
    guard let pid = (params["pid"] as? NSNumber)?.int32Value else {
        return ["error": "observe requires an integer pid"]
    }
    let windowId = (params["window_id"] as? NSNumber)?.uint32Value
    let includeImage = (params["include_image"] as? Bool) ?? true
    let includeTree = (params["include_tree"] as? Bool) ?? true
    // Clamped, never taken at face value: an unbounded `max_elements` is an unbounded read.
    let maxElements = clamped(
        (params["max_elements"] as? NSNumber)?.intValue, ObservationLimits.maxElementsDefault,
        ObservationLimits.maxElementsCeiling)
    let maxDepth = clamped(
        (params["max_depth"] as? NSNumber)?.intValue, ObservationLimits.maxDepthDefault,
        ObservationLimits.maxDepthCeiling)

    var result: [String: Any] = [
        "pid": Int(pid),
        // Echoed so a caller can see what was actually applied rather than what it asked for.
        "limits": [
            "max_elements": maxElements,
            "max_depth": maxDepth,
            "max_string_characters": ObservationLimits.maxStringCharacters,
            "max_actions_per_element": ObservationLimits.maxActionsPerElement,
        ],
    ]
    var evidence: [[String: Any]] = []
    var routes: [String] = []
    var failures: [String] = []
    var requested = 0
    var succeeded = 0

    if includeImage {
        requested += 1
        // ScreenCaptureKit's one-shot screenshot API is macOS 14+. The bundle floor is 12.0
        // (the product's declared floor), so on 12/13 the capture rung is unavailable and
        // `observe` degrades to the AX tree rather than failing.
        let capture: [String: Any]
        if #available(macOS 14.0, *) {
            capture = captureWindowImage(pid: pid, windowId: windowId)
        } else {
            capture = [
                "ok": false,
                "error": "ScreenCaptureKit capture requires macOS 14 or newer",
            ]
        }
        if capture["ok"] as? Bool == true {
            let blank = (capture["blank"] as? Bool) ?? false
            result["image"] = capture
            if blank {
                // A single-colour frame is what a refused capture looks like on macOS — CUA-0.5
                // measured that a missing Screen Recording grant yields a blank frame rather than
                // an error — so it must not count as a rung that succeeded. The frame is still
                // returned with its statistics, because "uniform" is also what a genuinely blank
                // window looks like, and the caller is the one that can tell the two apart.
                failures.append(
                    "screencapturekit: returned a blank frame (a single distinct colour); "
                        + "either Screen Recording is not effective for this Helper or the window "
                        + "really is uniform")
            } else {
                succeeded += 1
                routes.append("screencapturekit")
            }
            evidence.append([
                "kind": "pixel_stats",
                "width": capture["width"] ?? 0,
                "height": capture["height"] ?? 0,
                "distinct_sampled_colors": capture["distinct_sampled_colors"] ?? 0,
                "blank": blank,
            ])
        } else {
            result["image"] = NSNull()
            failures.append("screencapturekit: \(capture["error"] as? String ?? "unavailable")")
        }
    }

    if includeTree {
        requested += 1
        let tree = axSnapshot(pid: pid, maxElements: maxElements, maxDepth: maxDepth)
        if tree["ok"] as? Bool == true {
            succeeded += 1
            routes.append("ax")
            result["tree"] = tree
            evidence.append([
                "kind": "value_readback", "source": "AXUIElement",
                "count": tree["element_count"] ?? 0,
            ])
        } else {
            result["tree"] = NSNull()
            failures.append("ax: \(tree["reason"] as? String ?? "refused")")
        }
    }

    if !failures.isEmpty {
        result["error"] = failures.joined(separator: "; ")
    }
    let effect: String
    if requested == 0 {
        effect = "refused"
        result["error"] = "observe was asked for neither an image nor a tree"
    } else if succeeded == requested {
        effect = "confirmed"
    } else if succeeded > 0 {
        effect = "partial"
    } else {
        effect = "refused"
    }

    result.merge(
        brokerEnvelope(
            route: routes.isEmpty ? "none" : routes.joined(separator: "+"),
            effect: effect, evidence: evidence)) { current, _ in current }
    return result
}

// MARK: - Capture

/// Window-scoped capture. Falls back to the whole display only when no window id was given,
/// because a window-scoped capture is the one the observation contract promises.
@available(macOS 14.0, *)
func captureWindowImage(pid: pid_t, windowId: UInt32?) -> [String: Any] {
    _ = NSApplication.shared  // ScreenCaptureKit needs a GUI connection first.
    var finished: [String: Any]?
    func finish(_ value: [String: Any]) {
        DispatchQueue.main.async {
            finished = value
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }
    SCShareableContent.getExcludingDesktopWindows(
        false, onScreenWindowsOnly: false
    ) { content, error in
        guard let content else {
            finish([
                "ok": false,
                "error": "shareableContent: \(error?.localizedDescription ?? "unavailable")",
            ])
            return
        }
        let filter: SCContentFilter
        if let windowId, let window = content.windows.first(where: { $0.windowID == windowId }) {
            // Captures the window's own contents, independent of z-order.
            filter = SCContentFilter(desktopIndependentWindow: window)
        } else if let windowId {
            finish(["ok": false, "error": "window \(windowId) absent from shareable content"])
            return
        } else if let display = content.displays.first {
            filter = SCContentFilter(display: display, excludingWindows: [])
        } else {
            finish(["ok": false, "error": "no capture target available"])
            return
        }
        let config = SCStreamConfiguration()
        let scale = filter.pointPixelScale > 0 ? filter.pointPixelScale : 1
        config.width = Int(filter.contentRect.width * CGFloat(scale))
        config.height = Int(filter.contentRect.height * CGFloat(scale))
        config.showsCursor = false
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) {
            image, error in
            guard let image else {
                finish([
                    "ok": false,
                    "error": "captureImage: \(error?.localizedDescription ?? "nil image")",
                ])
                return
            }
            let distinct = distinctColorCount(image, stride: 97)
            let observationId = UUID().uuidString
            guard let path = writePng(image, observationId: observationId) else {
                finish(["ok": false, "error": "captured a frame but could not persist it"])
                return
            }
            finish([
                "ok": true,
                // `path` is host-internal: the socket is a host-side channel, and the model-facing
                // boundary strips it (packages/zcode-cua/observe-result.js). `observation_id`
                // survives that strip, so a future artifact bridge can ask for the bytes by id
                // without either side handing a filesystem path to the model.
                "path": path,
                "observation_id": observationId,
                "width": image.width,
                "height": image.height,
                "scale": scale,
                "distinct_sampled_colors": distinct,
                // One colour across the frame is the signature of a blank or denied capture.
                "blank": distinct <= 1,
            ])
        }
    }
    CFRunLoopRun()
    return finished ?? ["ok": false, "error": "capture timed out"]
}

/// Persist a captured frame. Frames cross the socket as references, never as base64 (§ spec).
///
/// Retention is bounded: a frame has no consumer once the result that referenced it has been read,
/// so the newest `ObservationStore.retainedFrames` are kept and older ones are removed. Without
/// this a long observation session grows one ~1.7 MB PNG per call forever. The directory is created
/// 0700 and files are written 0600, so frames are not readable by other local users.
func writePng(_ image: CGImage, observationId: String) -> String? {
    let dir = ObservationStore.directory
    try? FileManager.default.createDirectory(
        atPath: dir, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    // `createDirectory(attributes:)` does not re-mode a directory that already exists, and a store
    // created before this rule (or by anything else) would keep its old mode, so set it explicitly.
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
    let path = (dir as NSString).appendingPathComponent("\(observationId).png")
    let url = URL(fileURLWithPath: path)
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    pruneObservationStore(dir)
    return path
}

/// Keep the newest `retainedFrames` frames, drop the rest. Best-effort: a failure here must never
/// turn a successful capture into a failed one.
///
/// This treats `--observation-dir` as wholly owned by the helper and deletes every `*.png` in it
/// past the cap; point it at a dedicated directory, which is what the contract does.
func pruneObservationStore(_ dir: String) {
    guard
        let names = try? FileManager.default.contentsOfDirectory(atPath: dir)
    else { return }
    let frames = names.filter { $0.hasSuffix(".png") }
    guard frames.count > ObservationStore.retainedFrames else { return }
    let ordered = frames.compactMap { name -> (String, Date)? in
        let path = (dir as NSString).appendingPathComponent(name)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
            let modified = attributes[.modificationDate] as? Date
        else { return nil }
        return (path, modified)
    }.sorted { $0.1 > $1.1 }
    for (path, _) in ordered.dropFirst(ObservationStore.retainedFrames) {
        try? FileManager.default.removeItem(atPath: path)
    }
}

/// Where captured frames are written.
///
/// Set from `--observation-dir` when the launcher passes one, because the environment is *not* a
/// dependable channel here: the contract launches the Helper through LaunchServices (`/usr/bin/open`),
/// and a measured run showed the launched Helper does not receive the launcher's `ZCODE_HOME` — so
/// relying on the environment alone let a fork's frames land in the product's `~/.zcode`. A flag
/// travels with the launch; an environment variable may not.
enum ObservationStore {
    /// Populated from `--observation-dir` in main.swift before the socket server starts.
    static var override: String = ""

    /// How many captured frames are kept on disk. A frame exists to be referenced by the result
    /// that produced it; older ones have no reader, so keeping them only grows the data root.
    static let retainedFrames = 64

    static var directory: String {
        if !override.isEmpty { return override }
        if let fromEnv = ProcessInfo.processInfo.environment["ZCODE_CUA_OBSERVATION_DIR"],
            !fromEnv.isEmpty
        {
            return fromEnv
        }
        let home = ProcessInfo.processInfo.environment["ZCODE_HOME"]?.trimmingCharacters(
            in: .whitespaces)
        let base =
            (home?.isEmpty == false ? home! : NSHomeDirectory() + "/.zcode")
        return (base as NSString).appendingPathComponent("computer-use/observations")
    }
}

// MARK: - Accessibility tree

/// Attributes this walk is allowed to read, and the reason the list exists.
///
/// The AX surface of a real app also carries `AXDocument`, `AXFilename`, `AXURL` and friends,
/// whose values are host filesystem paths or URLs the user's own documents live at. None of them
/// is needed to describe what is on screen, and reading them would put arbitrary host paths into
/// an observation result. The allowlist is therefore closed and *enforced*: `axAttribute` in
/// `AxPrimitives.swift` is the only reader and refuses any name that is not in this list, so a
/// future call site cannot widen it by accident.
let axReadableAttributes: [String] = [
    kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXIdentifierAttribute, kAXEnabledAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXChildrenAttribute, kAXWindowsAttribute,
]

/// Bound one AX string before it enters a result. Truncation is reported to the caller rather
/// than silently hiding the fact that the value was longer than the contract allows.
func axBoundedString(_ element: AXUIElement, _ name: String, truncated: inout Bool) -> String? {
    guard let value = axString(element, name) else { return nil }
    guard value.count > ObservationLimits.maxStringCharacters else { return value }
    truncated = true
    return String(value.prefix(ObservationLimits.maxStringCharacters)) + "…"
}

/// Bounded AX walk of a target application.
///
/// Returns `ok: false` with a reason when the AX server refuses this process — which is what a
/// missing Accessibility grant looks like — rather than an empty tree, so the caller can tell
/// "denied" from "nothing to read".
func axSnapshot(pid: pid_t, maxElements: Int, maxDepth: Int) -> [String: Any] {
    // Clamped again here: this function's own contract is "bounded", not "bounded if the caller
    // remembered", so a future call site cannot accidentally ask for an unbounded walk.
    let elementCeiling = clamped(
        maxElements, ObservationLimits.maxElementsDefault, ObservationLimits.maxElementsCeiling)
    let depthCeiling = clamped(
        maxDepth, ObservationLimits.maxDepthDefault, ObservationLimits.maxDepthCeiling)

    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 3.0)

    var windowsValue: CFTypeRef?
    let windowsStatus = AXUIElementCopyAttributeValue(
        application, kAXWindowsAttribute as CFString, &windowsValue)
    guard windowsStatus == .success, let windows = windowsValue as? [AXUIElement] else {
        // Non-zero status means the AX server did not serve this process. The common cause is
        // a missing Accessibility grant, but a target with no AX surface fails the same way, so
        // both are named rather than asserting the grant.
        return [
            "ok": false,
            "reason": "AX did not serve this request (status \(windowsStatus.rawValue)); "
                + "either Accessibility is not granted to this Helper, or the target exposes "
                + "no accessibility windows",
            "ax_status": Int(windowsStatus.rawValue),
        ]
    }

    var elements: [[String: Any]] = []
    let observationId = UUID().uuidString.lowercased()
    let observedWindows = Array(windows.prefix(elementCeiling))
    let windowIdentityKeys = observedWindows.map { window in
        semanticWindowIdentityKey(
            identifier: axString(window, kAXIdentifierAttribute as String),
            title: axString(window, kAXTitleAttribute as String))
    }
    let windowIdentityCounts = Dictionary(grouping: windowIdentityKeys.compactMap { $0 }, by: { $0 })
        .mapValues(\.count)
    var truncated = windows.count > observedWindows.count
    var stringsTruncated = 0
    var queue: [(AXUIElement, Int, Int?, Int, [Int])] = observedWindows.enumerated().map {
        ($0.element, 0, nil, $0.offset, [])
    }
    var index = 0

    while let (element, depth, parent, windowOrdinal, elementPath) = queue.first {
        queue.removeFirst()
        if elements.count >= elementCeiling {
            truncated = true
            break
        }
        var entry: [String: Any] = ["index": index]
        var textTruncated = false
        // Role first: it is the field the client maps through ROLE_TO_KIND, so it is never
        // truncated away by a later field's bounds.
        entry["role"] = axBoundedString(element, kAXRoleAttribute as String, truncated: &textTruncated) ?? ""
        entry["label"] =
            axBoundedString(element, kAXTitleAttribute as String, truncated: &textTruncated)
            ?? axBoundedString(element, kAXDescriptionAttribute as String, truncated: &textTruncated)
            ?? ""
        if let value = axBoundedString(
            element, kAXValueAttribute as String, truncated: &textTruncated)
        {
            entry["value"] = value
        }
        if let identifier = axBoundedString(
            element, kAXIdentifierAttribute as String, truncated: &textTruncated)
        {
            entry["identifier"] = identifier
        }
        if let enabled = axBool(element, kAXEnabledAttribute as String) {
            entry["enabled"] = enabled
        }
        if let frame = axFrame(element) { entry["frame"] = frame }
        if let parent { entry["parent_index"] = parent }
        var actionNames: CFArray?
        if AXUIElementCopyActionNames(element, &actionNames) == .success,
            let names = actionNames as? [String]
        {
            entry["actions"] = Array(names.prefix(ObservationLimits.maxActionsPerElement))
        }
        let observedActions = actionNames as? [String] ?? []
        if semanticReferenceEligible(
            element: element, role: entry["role"] as? String ?? "", actions: observedActions,
            label: axString(element, kAXTitleAttribute as String)
                ?? axString(element, kAXDescriptionAttribute as String) ?? ""),
           let reference = rememberSemanticTarget(
                observationId: observationId, pid: pid, windowOrdinal: windowOrdinal,
                windowIdentifier: observedWindows.indices.contains(windowOrdinal)
                    ? axString(observedWindows[windowOrdinal], kAXIdentifierAttribute as String) : nil,
                windowTitle: observedWindows.indices.contains(windowOrdinal)
                    ? axString(observedWindows[windowOrdinal], kAXTitleAttribute as String) : nil,
                path: elementPath,
                windowIdentityUnique: windowIdentityKeys.indices.contains(windowOrdinal)
                    && windowIdentityCounts[windowIdentityKeys[windowOrdinal] ?? ""] == 1,
                role: entry["role"] as? String ?? "",
                identifier: axString(element, kAXIdentifierAttribute as String),
                label: axString(element, kAXTitleAttribute as String)
                    ?? axString(element, kAXDescriptionAttribute as String) ?? "") {
            entry["semantic_ref"] = reference
        }
        if textTruncated { stringsTruncated += 1 }
        elements.append(entry)

        let parentIndex = index
        index += 1
        var childrenValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
            == .success, let children = childrenValue as? [AXUIElement]
        {
            if depth + 1 > depthCeiling {
                // Only a node that *has* children we are not walking is truncated. Reporting
                // truncation for a leaf that merely sits at the depth limit would tell the caller
                // the tree is incomplete when it is complete.
                if !children.isEmpty { truncated = true }
            } else {
                for (childIndex, child) in children.enumerated() {
                    queue.append((child, depth + 1, parentIndex, windowOrdinal,
                                  elementPath + [childIndex]))
                }
            }
        }
    }

    // The AX server served us. A window with no title is a property of the target app, not a
    // hint about authorization, so the two are reported separately.
    return [
        "ok": true,
        "element_count": elements.count,
        "truncated": truncated,
        "strings_truncated": stringsTruncated,
        "observation_id": observationId,
        "elements": elements,
    ]
}

func axFrame(_ element: AXUIElement) -> [String: Double]? {
    guard let position = axPoint(element, kAXPositionAttribute as String),
        let size = axSize(element, kAXSizeAttribute as String)
    else { return nil }
    return [
        "x": Double(position.x), "y": Double(position.y),
        "w": Double(size.width), "h": Double(size.height),
    ]
}
