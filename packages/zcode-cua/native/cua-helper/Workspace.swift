// CUA workspace substrate (M2A, specs/computer-workspace.md): pid-targeted background
// actions that never touch the user's foreground or physical cursor.
//
//   workspace_click       — resolve the element inside the target app's window by
//                           role+label (or deepest element at a coordinate) and perform
//                           AXPress. No CGEvent mouse, no app activation, no lease.
//   workspace_type_text   — focus the window's text element via AX and deliver keyboard
//                           events with CGEventPostToPid. No event tap, no lease, no
//                           frontmost requirement.
//
// Both envelopes carry zero-steal evidence (frontmost + physical cursor before/after) so
// the harness invariant "user foreground unchanged" is measurable, not asserted.
// The substrate rides the SAME signed Helper identity and socket as every other broker
// method: no new TCC principal, no new credential surface.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct WorkspaceController {
    // MARK: - param validation mirrors the foreground contract's exact-key style

    static func validClickParams(_ params: [String: Any]) -> Bool {
        var allowed: Set<String> = ["pid", "window_ordinal", "owner_session", "owner_task"]
        var required: Set<String> = ["pid"]
        if params["point"] != nil {
            allowed.insert("point"); required.insert("point")
        } else if params["target_role"] != nil {
            allowed.formUnion(["target_role", "target_label"])
            required.formUnion(["target_role", "target_label"])
        } else {
            return false
        }
        guard Set(params.keys).isSubset(of: allowed), required.isSubset(of: Set(params.keys)) else {
            return false
        }
        if let point = params["point"] as? [String: Any] {
            guard point.count == 2,
                  (point["x"] as? NSNumber)?.doubleValue != nil,
                  (point["y"] as? NSNumber)?.doubleValue != nil else { return false }
        }
        for key in ["owner_session", "owner_task"] {
            if let value = params[key] as? String {
                guard !value.isEmpty, value.count <= 128,
                      !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
                else { return false }
            }
        }
        return true
    }

    static func validTypeParams(_ params: [String: Any]) -> Bool {
        guard Set(params.keys).isSubset(of: ["pid", "window_ordinal", "text", "target_label", "owner_session", "owner_task"]),
              params["pid"] is NSNumber,
              let text = params["text"] as? String,
              !text.isEmpty, text.utf16.count <= 512, !text.utf16.contains(0) else { return false }
        for key in ["owner_session", "owner_task"] {
            if let value = params[key] as? String {
                guard !value.isEmpty, value.count <= 128,
                      !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
                else { return false }
            }
        }
        return true
    }

    // MARK: - click

    static func click(_ params: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted() else {
            return workspaceRefusal("permission_required", "Accessibility permission is required")
        }
        guard let pid = (params["pid"] as? NSNumber)?.int32Value, pid > 0 else {
            return workspaceRefusal("bad_request", "workspace_click requires an integer pid")
        }
        let before = zeroStealSnapshot(pid: Int(pid))
        guard let (window, windowOrdinal) = resolveWindow(pid: pid, ordinal: (params["window_ordinal"] as? NSNumber)?.intValue) else {
            return workspaceRefusal("target_lost", "target window is not addressable right now")
        }
        let resolved: AXUIElement?
        var resolution: [String: Any] = [:]
        if let pointParams = params["point"] as? [String: Any],
           let x = (pointParams["x"] as? NSNumber)?.doubleValue,
           let y = (pointParams["y"] as? NSNumber)?.doubleValue {
            let deepest = deepestElement(in: window, containing: CGPoint(x: x, y: y))
            guard let element = deepest else {
                return workspaceRefusal("target_lost", "no element at the requested coordinate")
            }
            resolved = element
            resolution = ["strategy": "coordinate"]
        } else {
            let role = params["target_role"] as? String ?? ""
            let label = params["target_label"] as? String ?? ""
            let matches = elements(in: window).filter { candidate in
                axWSString(candidate, kAXRoleAttribute as String) == role
                    && labelMatches(candidate, label)
            }
            guard matches.count == 1, let element = matches.first else {
                return workspaceRefusal(
                    matches.count > 1 ? "ambiguous_target" : "target_lost",
                    matches.count > 1 ? "role+label matched multiple elements" : "no role+label match in the target window")
            }
            resolved = element
            resolution = ["strategy": "role_label", "matches": matches.count]
        }
        guard let element = resolved else {
            return workspaceRefusal("target_lost", "element resolution failed")
        }
        var actions: CFArray?
        let advertised = AXUIElementCopyActionNames(element, &actions) == .success
            && (actions as? [String])?.contains(kAXPressAction as String) == true
        let role = axWSString(element, kAXRoleAttribute as String) ?? ""
        let enabled = axWSBool(element, kAXEnabledAttribute as String)
        if let refusal = semanticPressRefusal(
            role: role,
            enabled: enabled ?? true,
            advertised: advertised,
            labelIsDisallowed: false) {
            return workspaceRefusal(refusal, "target is disabled or policy refuses this control")
        }
        var frameInfo: [String: Any] = [:]
        if let frame = axWSFrame(element) {
            frameInfo = ["element_frame": frameJSON(frame),
                         "element_center": ["x": Double(frame.midX), "y": Double(frame.midY)]]
        }
        let pressStatus = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard pressStatus == .success else {
            return workspaceRefusal("action_failed", "AXPress failed: \(pressStatus.rawValue)")
        }
        let after = zeroStealSnapshot(pid: Int(pid))
        var result = workspaceResult(
            operation: "workspace_click",
            effect: "unknown",
            route: "accessibility_action",
            delivery: "confirmed",
            application: "unknown")
        result["mode"] = "AGENT_WORKSPACE"
        result["classification"] = "BACKGROUND_SAFE"
        result["window_ordinal"] = windowOrdinal
        result["target"] = ["pid": Int(pid), "role": role].merging(resolution) { current, _ in current }
        result.merge(frameInfo) { current, _ in current }
        result["zero_steal"] = zeroStealEvidence(before, after)
        return result
    }

    // MARK: - type text

    static func typeText(_ params: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted() else {
            return workspaceRefusal("permission_required", "Accessibility permission is required")
        }
        guard let pid = (params["pid"] as? NSNumber)?.int32Value, pid > 0 else {
            return workspaceRefusal("bad_request", "workspace_type_text requires an integer pid")
        }
        guard let text = params["text"] as? String else {
            return workspaceRefusal("bad_request", "workspace_type_text requires text")
        }
        let before = zeroStealSnapshot(pid: Int(pid))
        guard let (window, windowOrdinal) = resolveWindow(pid: pid, ordinal: (params["window_ordinal"] as? NSNumber)?.intValue) else {
            return workspaceRefusal("target_lost", "target window is not addressable right now")
        }
        let textFields = elements(in: window).filter { candidate in
            let role = axWSString(candidate, kAXRoleAttribute as String) ?? ""
            return role == "AXTextField" || role == "AXTextArea"
        }
        guard !textFields.isEmpty else {
            return workspaceRefusal("no_text_target", "no text element in the target window")
        }
        // A multi-field window must be addressed explicitly to avoid typing into the wrong
        // field; single-field windows (the common workspace case) resolve directly.
        if textFields.count > 1, params["target_label"] == nil {
            return workspaceRefusal("ambiguous_target", "multiple text elements; address one by label")
        }
        var targetField = textFields[0]
        if let label = params["target_label"] as? String {
            let matches = textFields.filter { labelMatches($0, label) }
            guard matches.count == 1, let match = matches.first else {
                return workspaceRefusal("target_lost", "no unique text element with the requested label")
            }
            targetField = match
        }
        // 安全字段即使以普通 TextField 角色暴露也不能注入；拒绝发生在 AX focus 之前。
        guard axWSString(targetField, kAXSubroleAttribute as String) != "AXSecureTextField" else {
            return workspaceRefusal("secure_field", "secure text input is not supported")
        }
        let valuesBefore = Set(elements(in: window).flatMap { candidate in
            [axWSString(candidate, kAXValueAttribute as String), axWSString(candidate, kAXTitleAttribute as String),
             axWSString(candidate, kAXDescriptionAttribute as String)].compactMap { $0 }
        })
        let focusStatus = AXUIElementSetAttributeValue(targetField, kAXFocusedAttribute as CFString,
                                                       kCFBooleanTrue)
        let beforeValue = axWSString(targetField, kAXValueAttribute as String) ?? ""
        let units = Array(text.utf16)
        var sent = 0
        var posted = true
        while sent < units.count {
            let chunk = String(decoding: units[sent..<min(sent + 20, units.count)], as: UTF16.self)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                posted = false
                break
            }
            let codeUnits = Array(chunk.utf16)
            codeUnits.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: codeUnits.count, unicodeString: buffer.baseAddress)
            }
            down.postToPid(pid)
            usleep(8_000)
            up.postToPid(pid)
            sent += codeUnits.count
            usleep(8_000)
        }
        // Give the target's runloop a beat to apply the events before the readback.
        usleep(150_000)
        let afterValue = axWSString(targetField, kAXValueAttribute as String) ?? ""
        // Verification is deliberately broader than one control: the field's own AX value is
        // not readable for every AppKit control, but applications that echo input (labels,
        // editors) expose the delivered text somewhere in the window tree.
        // 用户已有内容不能证明新输入生效；只有发生变化的读回才支持 confirmed。
        var verifiedIn = afterValue != beforeValue && afterValue.hasSuffix(text) ? "field_value" : ""
        if verifiedIn.isEmpty {
            for candidate in elements(in: window) {
                let values = [
                    axWSString(candidate, kAXValueAttribute as String),
                    axWSString(candidate, kAXTitleAttribute as String),
                    axWSString(candidate, kAXDescriptionAttribute as String),
                ].compactMap { $0 }
                if values.contains(where: { $0.contains(text) && !valuesBefore.contains($0) }) {
                    verifiedIn = "window_tree"
                    break
                }
            }
        }
        let verified = posted && !verifiedIn.isEmpty
        let after = zeroStealSnapshot(pid: Int(pid))
        let effect = verified ? "confirmed" : (posted ? "unknown" : "failed")
        var result = workspaceResult(
            operation: "workspace_type_text",
            effect: effect,
            route: "quartz_input",
            delivery: posted ? "confirmed" : "none",
            application: verified ? "confirmed" : "unknown")
        result["mode"] = "AGENT_WORKSPACE"
        result["classification"] = "BACKGROUND_SAFE"
        result["window_ordinal"] = windowOrdinal
        result["input_delivery"] = posted ? "confirmed" : "none"
        result["value_before"] = String(beforeValue.suffix(semanticValueLimit))
        result["value_after"] = String(afterValue.suffix(semanticValueLimit))
        result["verification"] = verified ? verifiedIn : "unverified"
        result["focus_set_status"] = Int(focusStatus.rawValue)
        if let frame = axWSFrame(targetField) {
            result["element_center"] = ["x": Double(frame.midX), "y": Double(frame.midY)]
        }
        result["zero_steal"] = zeroStealEvidence(before, after)
        return result
    }

    // MARK: - primitives

    static func scroll(_ params: [String: Any]) -> [String: Any] {
        guard Set(params.keys).isSubset(of: ["pid", "delta", "owner_session", "owner_task"]),
              let pid = (params["pid"] as? NSNumber)?.int32Value, pid > 0,
              let delta = (params["delta"] as? NSNumber)?.doubleValue,
              delta.isFinite, abs(delta) <= 1, delta != 0 else {
            return workspaceRefusal("bad_request", "workspace_scroll requires pid and delta (-1...1)")
        }
        guard AXIsProcessTrusted(), let (window, _) = resolveWindow(pid: pid, ordinal: nil) else {
            return workspaceRefusal("target_lost", "target is unavailable")
        }
        let bars = elements(in: window).filter { axWSString($0, kAXRoleAttribute as String) == "AXScrollBar" }
        guard bars.count == 1, let bar = bars.first else {
            return workspaceRefusal("unsupported", "a unique writable scrollbar is required")
        }
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(bar, kAXValueAttribute as CFString, &raw) == .success,
              let previous = (raw as? NSNumber)?.doubleValue else {
            return workspaceRefusal("unsupported", "scrollbar position is unreadable")
        }
        let before = zeroStealSnapshot(pid: Int(pid))
        let requested = max(0, min(1, previous + delta))
        let status = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: requested))
        guard status == .success else { return workspaceRefusal("unsupported", "scrollbar is not writable") }
        var readback: CFTypeRef?
        AXUIElementCopyAttributeValue(bar, kAXValueAttribute as CFString, &readback)
        // 已在边界的相同值不是滚动发生的证据。
        let verified = requested != previous && (readback as? NSNumber)?.doubleValue == requested
        var result = workspaceResult(operation: "workspace_scroll", effect: verified ? "confirmed" : "unknown",
            route: "accessibility_action", delivery: "confirmed", application: verified ? "confirmed" : "unknown")
        result["mode"] = "AGENT_WORKSPACE"; result["classification"] = "BACKGROUND_SAFE"
        result["zero_steal"] = zeroStealEvidence(before, zeroStealSnapshot(pid: Int(pid)))
        return result
    }

    static func targetWindowFrame(pid: pid_t) -> CGRect? {
        guard let (window, _) = resolveWindow(pid: pid, ordinal: nil) else { return nil }
        return axWSFrame(window)
    }

    /// Resolve the target window by ordinal (default 0) against the app's AX window list.
    private static func resolveWindow(pid: pid_t, ordinal: Int?) -> (AXUIElement, Int)? {
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 2.0)
        var windowsValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString,
                                            &windowsValue) == .success,
              let rawWindows = windowsValue as? [AXUIElement] else { return nil }
        // SCK 持续捕获时系统把 WindowSharingSessionButton 浮窗插到 AXWindows 首位。
        // 它不是 agent 的应用窗口；按旧 ordinal 0 会把点击/输入错路由到系统分享指示器。
        let windows = rawWindows.filter { window in
            !elements(in: window).contains { element in
                [axWSString(element, kAXTitleAttribute as String),
                 axWSString(element, kAXDescriptionAttribute as String),
                 axWSString(element, kAXIdentifierAttribute as String)].compactMap { $0 }
                    .contains("WindowSharingSessionButton")
            }
        }
        // 指定 ordinal 已消失时必须拒绝；不能夹取到另一窗口后继续输入。
        let index = ordinal ?? 0
        guard windows.indices.contains(index) else { return nil }
        return (windows[index], index)
    }

    /// Depth-first element enumeration below a window (bounded like the observation tree).
    private static func elements(in window: AXUIElement) -> [AXUIElement] {
        var collected: [AXUIElement] = []
        var queue: [AXUIElement] = [window]
        var visited = 0
        while !queue.isEmpty, visited < 2000 {
            let element = queue.removeFirst()
            visited += 1
            collected.append(element)
            var childrenValue: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString,
                                                &childrenValue) == .success,
                  let children = childrenValue as? [AXUIElement] else { continue }
            queue.append(contentsOf: children)
        }
        return collected
    }

    private static func deepestElement(in window: AXUIElement, containing point: CGPoint) -> AXUIElement? {
        var deepest: AXUIElement?
        for candidate in elements(in: window) {
            guard let frame = axWSFrame(candidate), frame.contains(point) else { continue }
            deepest = candidate
        }
        return deepest
    }

    private static func labelMatches(_ element: AXUIElement, _ label: String) -> Bool {
        let title = axWSString(element, kAXTitleAttribute as String)
        let description = axWSString(element, kAXDescriptionAttribute as String)
        let value = axWSString(element, kAXValueAttribute as String)
        return [title, description, value].compactMap { $0 }.contains { $0.caseInsensitiveCompare(label) == .orderedSame }
    }

    static func axWSString(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? String
    }

    static func axWSBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? Bool
    }

    static func axWSFrame(_ element: AXUIElement) -> CGRect? {
        guard let position = axPoint(element, kAXPositionAttribute as String),
              let size = axSize(element, kAXSizeAttribute as String) else { return nil }
        return CGRect(origin: position, size: size)
    }

    private static func frameJSON(_ frame: CGRect) -> [String: Double] {
        ["x": Double(frame.minX), "y": Double(frame.minY),
         "w": Double(frame.width), "h": Double(frame.height)]
    }

    // MARK: - zero-steal evidence

    private struct ZeroStealSnapshot {
        let frontmost: Int
        let cursor: [String: Double]?
    }

    private static func zeroStealSnapshot(pid: Int) -> ZeroStealSnapshot {
        ZeroStealSnapshot(frontmost: frontmostPid(), cursor: cursorLocation())
    }

    private static func zeroStealEvidence(_ before: ZeroStealSnapshot,
                                          _ after: ZeroStealSnapshot) -> [String: Any] {
        let cursorUnchanged = before.cursor == nil || after.cursor == nil
            ? nil
            : before.cursor?["x"] == after.cursor?["x"] && before.cursor?["y"] == after.cursor?["y"]
        return [
            "kind": "zero_steal",
            "frontmost_before": before.frontmost,
            "frontmost_after": after.frontmost,
            "frontmost_unchanged": before.frontmost == after.frontmost,
            "cursor_before": before.cursor ?? NSNull(),
            "cursor_after": after.cursor ?? NSNull(),
            "cursor_unchanged": cursorUnchanged ?? NSNull(),
        ]
    }

    // MARK: - envelopes

    private static func workspaceRefusal(_ code: String, _ message: String) -> [String: Any] {
        [
            "operation": "workspace",
            "effect": "refused", "code": code, "message": message,
            "route": "none", "classification": "BACKGROUND_SAFE", "mode": "AGENT_WORKSPACE",
            "input_delivery": "none", "application_effect": "unknown",
            "evidence": [],
            "helper_identity": shortIdentityJSON(helperSelfIdentity),
        ]
    }

    private static func workspaceResult(operation: String, effect: String, route: String,
                                        delivery: String, application: String) -> [String: Any] {
        [
            "operation": operation,
            "effect": effect,
            "route": route,
            "classification": "BACKGROUND_SAFE",
            "mode": "AGENT_WORKSPACE",
            "input_delivery": delivery,
            "application_effect": application,
            "evidence": [],
            "helper_identity": shortIdentityJSON(helperSelfIdentity),
        ]
    }
}
