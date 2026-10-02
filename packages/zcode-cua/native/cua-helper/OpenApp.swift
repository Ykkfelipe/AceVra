// open_app：本地后台打开应用 / 为无窗口运行中的应用重建窗口。
// 修复依据（preview-ux-98d1d7f 实测）：Chrome 按 ⌘W/红 X 后进程仍在、窗口为 0，
// canonical 面没有任何后台"打开应用"方法，模型只能反复观察空 AX 树，最终退向
// 前台接管并放弃任务。远程（Dell）运行时靠进程派生天然具备该能力；这里补齐本地
// 对应能力：经 LaunchServices 后台投递 open/reopen 事件（activates=false，不抢前台），
// 部分应用（Chrome）会延迟自激活，因此复用 settle/restore 守卫（f4fdd904 修复），
// 最后如实校验可用窗口是否真的出现——不给模型"unknown 当成功"的借口。

import AppKit

/// 与 list_windows 同一判定：layer 0、短边 ≥40pt 的窗口才算"可用窗口"，
/// 排除 64x64 的窗口服务器记账/CursorUIViewService 桩。
private func usableWindowCount(pid: pid_t) -> Int {
    let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    return raw.filter { window in
        (window[kCGWindowLayer as String] as? Int ?? -1) == 0
            && (window[kCGWindowOwnerPID as String] as? Int ?? 0) == pid
            && ((window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:])["Width"] ?? 0) >= 40
            && ((window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:])["Height"] ?? 0) >= 40
    }.count
}

private func openAppEnvelope(
    effect: String, bundleId: String, pid: Int, launched: Bool, windows: Int,
    evidence: [[String: Any]]
) -> [String: Any] {
    var result: [String: Any] = [
        "operation": "open_app",
        "classification": "BEST_EFFORT_BACKGROUND",
        "bundle_id": bundleId,
        "pid": pid,
        "launched": launched,
        "usable_windows": windows,
        "evidence": evidence,
    ]
    result.merge(
        brokerEnvelope(route: "workspace", effect: effect)) { current, _ in current }
    return result
}

func performOpenApp(_ params: [String: Any]) -> [String: Any] {
    let bundleId = (params["bundle_id"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !bundleId.isEmpty else {
        // 结果内拒绝用 refuse 形状（transport 级 brokerFail 由 dispatch 层负责）。
        return ["effect": "refused", "code": "bad_request",
                "message": "open_app requires bundle_id", "route": "none", "evidence": []]
    }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
        var result = openAppEnvelope(
            effect: "failed", bundleId: bundleId, pid: 0, launched: false, windows: 0,
            evidence: [["kind": "app_lookup", "matched": false]])
        result["code"] = "app_not_found"
        return result
    }

    let running = NSWorkspace.shared.runningApplications.first {
        $0.activationPolicy == .regular && $0.bundleIdentifier == bundleId
            && $0.processIdentifier > 0
    }
    let pid = running.map { Int($0.processIdentifier) } ?? 0
    let windowsBefore = pid > 0 ? usableWindowCount(pid: pid_t(pid)) : 0
    let frontmostBefore = liveFrontmostPid()

    // 对已运行的应用，openApplication 投递 open-application(reopen) 事件而不启动新实例；
    // activates=false 保证 LaunchServices 侧不主动抢前台。
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    var openError: Error?
    let done = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
        openError = error
        done.signal()
    }
    _ = done.wait(timeout: .now() + 5)
    if let openError {
        var result = openAppEnvelope(
            effect: "failed", bundleId: bundleId, pid: pid, launched: running == nil,
            windows: windowsBefore,
            evidence: [["kind": "open_application", "error": String(describing: openError)]])
        result["code"] = "open_failed"
        return result
    }

    // 有界等待窗口出现；浏览器等应用延迟建窗，立刻读会误报失败。
    var windowsAfter = pid > 0 ? usableWindowCount(pid: pid_t(pid)) : 0
    let deadline = Date().addingTimeInterval(2.5)
    while Date() < deadline && windowsAfter == windowsBefore && windowsAfter == 0 {
        CFRunLoopRunInMode(.defaultMode, 0.05, false)
        windowsAfter = pid > 0 ? usableWindowCount(pid: pid_t(pid)) : 0
    }

    var evidence: [[String: Any]] = [
        ["kind": "open_application", "launched_fresh": running == nil],
        ["kind": "window_readback", "before": windowsBefore, "after": windowsAfter],
    ]
    // 应用可能在事件后自激活（f4fdd904 修复的同一行为）：有界观察并把前台还给用户。
    let settle = settleForegroundAfterBackgroundAction(
        frontmostBefore: frontmostBefore, targetPid: pid)
    evidence.append(settle)

    let effect = windowsAfter > windowsBefore || (windowsBefore == 0 && windowsAfter > 0)
        ? "confirmed" : (running == nil ? "unknown" : "failed")
    var result = openAppEnvelope(
        effect: effect, bundleId: bundleId, pid: pid, launched: running == nil,
        windows: windowsAfter, evidence: evidence)
    if effect != "confirmed" { result["code"] = "no_window" }
    return result
}
