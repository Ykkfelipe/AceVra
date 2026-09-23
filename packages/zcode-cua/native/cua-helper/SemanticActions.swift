// CUA-2 semantic Accessibility actions. References are opaque capabilities kept only in this
// Helper process; AXUIElement pointers never cross the broker boundary.
import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation

private struct SemanticTarget {
    let observationId: String
    let pid: pid_t
    let processStart: String
    let windowOrdinal: Int
    let windowIdentifierFingerprint: String?
    let windowTitleFingerprint: String?
    let path: [Int]
    let role: String
    let identifierFingerprint: String?
    let labelFingerprint: String?
    let labelIsDisallowed: Bool
    let expiresAt: Date
}

private let semanticTargetLock = NSLock()
private var semanticTargets: [String: SemanticTarget] = [:]
private let semanticReferenceLifetime: TimeInterval = 60
private let semanticReferenceLimit = 256

func semanticReferenceEligible(element: AXUIElement, role: String, actions: [String], label: String) -> Bool {
    guard label.count <= 4096, !semanticLabelIsDisallowed(label) else { return false }
    if semanticPressRoles.contains(role), actions.contains(kAXPressAction as String) { return true }
    guard semanticValueRoles.contains(role) else { return false }
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(
        element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

func rememberSemanticTarget(observationId: String, pid: pid_t, windowOrdinal: Int,
                            windowIdentifier: String?, windowTitle: String?, path: [Int],
                            windowIdentityUnique: Bool, role: String, identifier: String?, label: String) -> String? {
    guard windowIdentityUnique, (windowIdentifier?.count ?? 0) <= 4096,
          (windowTitle?.count ?? 0) <= 4096, (identifier?.count ?? 0) <= 4096,
          label.count <= 4096 else { return nil }
    let windowFingerprint = semanticFingerprint(windowIdentifier)
    let titleFingerprint = semanticFingerprint(windowTitle)
    let identifierFingerprint = semanticFingerprint(identifier)
    let labelFingerprint = semanticFingerprint(label)
    guard (windowFingerprint != nil || titleFingerprint != nil),
          (identifierFingerprint != nil || labelFingerprint != nil) else { return nil }
    let reference = UUID().uuidString.lowercased()
    let target = SemanticTarget(observationId: observationId, pid: pid, processStart: processStartIdentity(pid),
                                windowOrdinal: windowOrdinal,
                                windowIdentifierFingerprint: windowFingerprint,
                                windowTitleFingerprint: titleFingerprint,
                                path: path, role: role,
                                identifierFingerprint: identifierFingerprint,
                                labelFingerprint: labelFingerprint,
                                labelIsDisallowed: semanticLabelIsDisallowed(label),
                                expiresAt: Date().addingTimeInterval(semanticReferenceLifetime))
    semanticTargetLock.lock()
    semanticTargets = semanticTargets.filter { $0.value.expiresAt > Date() }
    guard semanticTargets.count < semanticReferenceLimit else {
        semanticTargetLock.unlock()
        return nil
    }
    semanticTargets[reference] = target
    semanticTargetLock.unlock()
    return reference
}

func semanticWindowIdentityKey(identifier: String?, title: String?) -> String? {
    guard (identifier?.count ?? 0) <= 4096, (title?.count ?? 0) <= 4096 else { return nil }
    let id = semanticFingerprint(identifier)
    let titleHash = semanticFingerprint(title)
    guard id != nil || titleHash != nil else { return nil }
    return "\(id ?? "-"):\(titleHash ?? "-")"
}

private func semanticFingerprint(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value.count <= 4096 else { return nil }
    return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

private func processStartIdentity(_ pid: pid_t) -> String {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    let read = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
    guard read == size else { return "unavailable" }
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}

private func takeSemanticTarget(_ reference: String) -> SemanticTarget? {
    semanticTargetLock.lock()
    defer { semanticTargetLock.unlock() }
    guard let target = semanticTargets[reference], target.expiresAt > Date() else {
        semanticTargets.removeValue(forKey: reference)
        return nil
    }
    return target
}

private func axStringValue(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? String
}

private func resolveSemanticTarget(_ target: SemanticTarget) -> AXUIElement? {
    guard processStillMatches(target) else { return nil }
    let application = AXUIElementCreateApplication(target.pid)
    AXUIElementSetMessagingTimeout(application, 2.0)
    var windowsValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString,
                                        &windowsValue) == .success,
          let windows = windowsValue as? [AXUIElement],
          windows.indices.contains(target.windowOrdinal) else { return nil }
    let window = windows[target.windowOrdinal]
    let currentWindowIdentifier = semanticFingerprint(axStringValue(window, kAXIdentifierAttribute as String))
    let currentWindowTitle = semanticFingerprint(axStringValue(window, kAXTitleAttribute as String))
    guard target.windowIdentifierFingerprint != nil || target.windowTitleFingerprint != nil,
          currentWindowIdentifier == target.windowIdentifierFingerprint,
          currentWindowTitle == target.windowTitleFingerprint else { return nil }
    var element = window
    for (pathIndex, childIndex) in target.path.enumerated() {
        var childrenValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString,
                                            &childrenValue) == .success,
              let children = childrenValue as? [AXUIElement],
              children.indices.contains(childIndex) else { return nil }
        element = children[childIndex]
        if pathIndex == target.path.count - 1 {
            let matchingSiblings = children.filter { candidate in
                axStringValue(candidate, kAXRoleAttribute as String) == target.role
                    && semanticFingerprint(axStringValue(candidate, kAXIdentifierAttribute as String))
                        == target.identifierFingerprint
                    && semanticFingerprint(axStringValue(candidate, kAXTitleAttribute as String)
                        ?? axStringValue(candidate, kAXDescriptionAttribute as String))
                        == target.labelFingerprint
            }
            guard matchingSiblings.count == 1 else { return nil }
        }
    }
    guard axStringValue(element, kAXRoleAttribute as String) == target.role else { return nil }
    let currentIdentifier = semanticFingerprint(axStringValue(element, kAXIdentifierAttribute as String))
    let currentLabel = semanticFingerprint(
        axStringValue(element, kAXTitleAttribute as String)
            ?? axStringValue(element, kAXDescriptionAttribute as String))
    guard currentIdentifier == target.identifierFingerprint,
          currentLabel == target.labelFingerprint else {
        return nil
    }
    return element
}

private func targetWindowState(_ target: SemanticTarget) -> (identity: String?, main: Bool?, focused: Bool?) {
    guard processStillMatches(target) else { return (nil, nil, nil) }
    let application = AXUIElementCreateApplication(target.pid)
    AXUIElementSetMessagingTimeout(application, 2.0)
    var windowsValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString,
                                        &windowsValue) == .success,
          let windows = windowsValue as? [AXUIElement] else { return (nil, nil, nil) }
    let matches = windows.filter { window in
        semanticFingerprint(axStringValue(window, kAXIdentifierAttribute as String))
            == target.windowIdentifierFingerprint
            && semanticFingerprint(axStringValue(window, kAXTitleAttribute as String))
                == target.windowTitleFingerprint
    }
    guard matches.count == 1, let window = matches.first else { return (nil, nil, nil) }
    let identity = semanticWindowIdentityKey(
        identifier: axStringValue(window, kAXIdentifierAttribute as String),
        title: axStringValue(window, kAXTitleAttribute as String))
    let main = axWindowFlag(window, kAXMainAttribute as String)
    let focused = axWindowFlag(window, kAXFocusedAttribute as String)
    return (identity, main, focused)
}

private func axWindowFlag(_ window: AXUIElement, _ attribute: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? Bool
}

private func processStillMatches(_ target: SemanticTarget) -> Bool {
    target.processStart != "unavailable" && processStartIdentity(target.pid) == target.processStart
}

private func safeValue(_ element: AXUIElement) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
          let value else { return nil }
    if let string = value as? String { return String(string.prefix(semanticValueLimit)) }
    if let number = value as? NSNumber { return number }
    return nil
}

private func frontmostPid() -> Int {
    Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
}

private func cursorLocation() -> [String: Double]? {
    guard let point = CGEvent(source: nil)?.location else { return nil }
    return ["x": Double(point.x), "y": Double(point.y)]
}

private func focusedWindowIdentity(_ pid: Int) -> String? {
    guard pid > 0 else { return nil }
    let application = AXUIElementCreateApplication(pid_t(pid))
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString,
                                        &value) == .success, let value,
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let window = (value as! AXUIElement)
    return semanticWindowIdentityKey(identifier: axStringValue(window, kAXIdentifierAttribute as String),
                                     title: axStringValue(window, kAXTitleAttribute as String))
}

private func refuse(_ code: String, _ message: String) -> [String: Any] {
    ["effect": "refused", "code": code, "message": message,
     "route": "none", "evidence": []]
}

func performSemanticPress(_ params: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else { return refuse("permission_required", "Accessibility permission is required") }
    guard let reference = params["semantic_ref"] as? String,
          let target = takeSemanticTarget(reference) else {
        return refuse("stale_target", "semantic reference is unknown or expired")
    }
    guard let element = resolveSemanticTarget(target) else {
        return refuse("stale_target", "target process, window, path, or fingerprint changed")
    }
    var actions: CFArray?
    let advertised = AXUIElementCopyActionNames(element, &actions) == .success
        && (actions as? [String])?.contains(kAXPressAction as String) == true
    if let refusal = semanticPressRefusal(
        role: target.role,
        enabled: axBool(element, kAXEnabledAttribute as String),
        advertised: advertised,
        labelIsDisallowed: target.labelIsDisallowed) {
        return refuse(refusal, refusal == "not_authorized"
            ? "target is disabled or policy refuses this control" : "AXPress is unsupported")
    }
    let beforeValue = safeValue(element) ?? NSNull()
    let beforeFrontmost = frontmostPid()
    let beforeWindow = focusedWindowIdentity(beforeFrontmost)
    let beforeTargetWindow = focusedWindowIdentity(Int(target.pid))
    let beforeTargetState = targetWindowState(target)
    let beforeCursor = cursorLocation()
    let actionStatus = AXUIElementPerformAction(element, kAXPressAction as CFString)
    let processUnchanged = processStillMatches(target)
    let postElement = resolveSemanticTarget(target)
    let afterValue = postElement.flatMap { safeValue($0) } ?? NSNull()
    let afterFrontmost = frontmostPid()
    let afterWindow = focusedWindowIdentity(afterFrontmost)
    let afterTargetWindow = focusedWindowIdentity(Int(target.pid))
    let afterTargetState = targetWindowState(target)
    let afterCursor = cursorLocation()
    let invariants = beforeFrontmost == afterFrontmost && beforeWindow != nil
        && beforeWindow == afterWindow && beforeTargetWindow != nil
        && beforeTargetWindow == afterTargetWindow
        && beforeTargetState.identity != nil
        && beforeTargetState.identity == afterTargetState.identity
        && beforeTargetState.main != nil && beforeTargetState.main == afterTargetState.main
        && beforeTargetState.focused != nil && beforeTargetState.focused == afterTargetState.focused
        && beforeCursor != nil && beforeCursor == afterCursor
    // AX API status is evidence, not proof; only a target transition confirms a press.
    let targetChanged = postElement != nil && !valuesEqual(beforeValue, afterValue)
    let verified = processUnchanged && actionStatus == .success && targetChanged
    let targetWindowUnchanged = beforeTargetState.identity != nil
        && beforeTargetState.identity == afterTargetState.identity
        && beforeTargetState.main != nil && beforeTargetState.main == afterTargetState.main
        && beforeTargetState.focused != nil && beforeTargetState.focused == afterTargetState.focused
    let safeBefore = nonSensitiveValueEvidence(beforeValue)
    let safeAfter = nonSensitiveValueEvidence(afterValue)
    return semanticActionResult(operation: "press", target: target, before: safeBefore,
                                after: safeAfter, apiStatus: actionStatus.rawValue,
                                verified: verified, invariants: invariants,
                                frontmostBefore: beforeFrontmost, frontmostAfter: afterFrontmost,
                                windowUnchanged: beforeWindow != nil && beforeWindow == afterWindow,
                                targetWindowUnchanged: targetWindowUnchanged,
                                cursorBefore: beforeCursor, cursorAfter: afterCursor,
                                treeChanged: false,
                                preTreeDigest: nil, postTreeDigest: nil)
}

func performSemanticSetValue(_ params: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else { return refuse("permission_required", "Accessibility permission is required") }
    guard let reference = params["semantic_ref"] as? String,
          let value = params["value"], let target = takeSemanticTarget(reference) else {
        return refuse("invalid_value", "semantic_ref and value are required")
    }
    guard let element = resolveSemanticTarget(target) else {
        return refuse("stale_target", "target process, window, path, or fingerprint changed")
    }
    var settable: DarwinBoolean = false
    let attributeIsSettable = AXUIElementIsAttributeSettable(
        element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
    if let refusal = semanticSetValueRefusal(
        role: target.role,
        enabled: axBool(element, kAXEnabledAttribute as String),
        settable: attributeIsSettable,
        value: value,
        labelIsDisallowed: target.labelIsDisallowed) {
        return refuse(refusal, "AXValue role, state, type, or write permission is invalid")
    }
    let boundedValue = value
    let before = safeValue(element) ?? NSNull()
    let beforeFrontmost = frontmostPid()
    let beforeWindow = focusedWindowIdentity(beforeFrontmost)
    let beforeTargetWindow = focusedWindowIdentity(Int(target.pid))
    let beforeTargetState = targetWindowState(target)
    let beforeCursor = cursorLocation()
    let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString,
                                              boundedValue as CFTypeRef)
    let processUnchanged = processStillMatches(target)
    let postElement = resolveSemanticTarget(target)
    let after = postElement.flatMap { safeValue($0) } ?? NSNull()
    let afterFrontmost = frontmostPid()
    let afterWindow = focusedWindowIdentity(afterFrontmost)
    let afterTargetWindow = focusedWindowIdentity(Int(target.pid))
    let afterTargetState = targetWindowState(target)
    let afterCursor = cursorLocation()
    // Readback is authoritative even when the setter's status is inconclusive.
    let invariants = beforeFrontmost == afterFrontmost && beforeWindow != nil
        && beforeWindow == afterWindow && beforeTargetWindow != nil
        && beforeTargetWindow == afterTargetWindow
        && beforeTargetState.identity != nil
        && beforeTargetState.identity == afterTargetState.identity
        && beforeTargetState.main != nil && beforeTargetState.main == afterTargetState.main
        && beforeTargetState.focused != nil && beforeTargetState.focused == afterTargetState.focused
        && beforeCursor != nil && beforeCursor == afterCursor
    let verified = processUnchanged && invariants && valuesEqual(after, boundedValue)
    let targetWindowUnchanged = beforeTargetState.identity != nil
        && beforeTargetState.identity == afterTargetState.identity
        && beforeTargetState.main != nil && beforeTargetState.main == afterTargetState.main
        && beforeTargetState.focused != nil && beforeTargetState.focused == afterTargetState.focused
    return semanticActionResult(operation: "set_value", target: target,
                                before: nonSensitiveValueEvidence(before),
                                after: nonSensitiveValueEvidence(after),
                                apiStatus: status.rawValue, verified: verified,
                                invariants: invariants,
                                frontmostBefore: beforeFrontmost, frontmostAfter: afterFrontmost,
                                windowUnchanged: beforeWindow != nil && beforeWindow == afterWindow,
                                targetWindowUnchanged: targetWindowUnchanged,
                                cursorBefore: beforeCursor, cursorAfter: afterCursor,
                                treeChanged: false, preTreeDigest: nil, postTreeDigest: nil)
}

private func nonSensitiveValueEvidence(_ value: Any) -> Any {
    if value is NSNull { return NSNull() }
    if let string = value as? String {
        return ["type": "string", "length": string.count]
    }
    if let number = value as? NSNumber {
        return ["type": "number", "value": number]
    }
    return NSNull()
}

private func valuesEqual(_ lhs: Any, _ rhs: Any) -> Bool {
    if let left = lhs as? String, let right = rhs as? String { return left == right }
    if let left = lhs as? NSNumber, let right = rhs as? NSNumber { return left == right }
    return false
}

private func semanticActionResult(operation: String, target: SemanticTarget, before: Any,
                                  after: Any, apiStatus: Int32, verified: Bool, invariants: Bool,
                                  frontmostBefore: Int, frontmostAfter: Int,
                                  windowUnchanged: Bool, targetWindowUnchanged: Bool,
                                  cursorBefore: [String: Double]?,
                                  cursorAfter: [String: Double]?, treeChanged: Bool,
                                  preTreeDigest: String?, postTreeDigest: String?) -> [String: Any] {
    let effect = semanticActionEffect(
        apiSucceeded: apiStatus == 0,
        stateVerified: verified,
        invariantsHeld: invariants)
    return ["operation": operation, "observation_id": target.observationId,
            "route": "accessibility_action", "effect": effect,
            "classification": "BEST_EFFORT_BACKGROUND",
            "delivery": ["mode": invariants ? "background" : "foreground_changed"],
            "evidence": [["kind": "semantic_action", "pre_state": ["role": target.role, "value": before],
                          "post_state": ["value": after], "api_status": Int(apiStatus),
                          "verification": verified ? "matched" : "unproven",
                          "frontmost_before_pid": frontmostBefore, "frontmost_after_pid": frontmostAfter,
                          "frontmost_unchanged": frontmostBefore == frontmostAfter,
                          "focused_window_unchanged": windowUnchanged,
                          "target_window_unchanged": targetWindowUnchanged,
                          "target_non_frontmost_before": frontmostBefore != Int(target.pid),
                          "target_non_frontmost_after": frontmostAfter != Int(target.pid),
                          "accessibility_subtree_changed": treeChanged,
                          "pre_state_digest": preTreeDigest as Any? ?? NSNull(),
                          "post_state_digest": postTreeDigest as Any? ?? NSNull(),
                          "cursor_before": cursorBefore as Any? ?? NSNull(),
                          "cursor_after": cursorAfter as Any? ?? NSNull(),
                          "cursor_unchanged": cursorBefore == cursorAfter,
                          "target_non_frontmost": frontmostAfter != Int(target.pid)]]
    ]
}
