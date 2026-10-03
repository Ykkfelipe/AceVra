// System arrow visibility while the agent holds an exclusive lease (specs/computer-use.md
// "Visible agent pointer"). AceVra draws its own reticle on the pointer; hiding the arrow makes the
// reticle the only pointer the user sees while the agent drives.
//
// macOS lets only the frontmost app hide the cursor. A background process (the Helper is never
// frontmost during a takeover) must first set the private `SetsCursorInBackground` property on its
// own window-server connection. Both private symbols are resolved at runtime: if either is absent
// the arrow stays visible (fail-visible, never fail-hidden). The hide count belongs to this
// process's connection, so the window server restores the arrow if the Helper exits or crashes.

import CoreGraphics
import Foundation

enum AgentCursorVisibility {
    private typealias DefaultConnection = @convention(c) () -> Int32
    private typealias SetConnectionProperty =
        @convention(c) (Int32, Int32, CFString, CFTypeRef) -> Int32

    private static let lock = NSLock()
    private static var hidden = false
    /// Every successful hide is counted so the lease end shows the arrow exactly as often.
    private static var hideCount = 0
    private static var ticker: DispatchSourceTimer?
    private static var tick = 0
    /// While the agent is moving/clicking, re-hide every tick (10 ms); at rest every 15th (150 ms).
    private static var burstUntil = Date.distantPast
    private static var backgroundControl: Bool?

    /// One-time opt-in so a background process may change cursor visibility.
    private static func enableBackgroundControl() -> Bool {
        if let backgroundControl { return backgroundControl }
        let everywhere = UnsafeMutableRawPointer(bitPattern: -2)  // RTLD_DEFAULT
        guard let defaultSymbol = dlsym(everywhere, "_CGSDefaultConnection"),
              let setSymbol = dlsym(everywhere, "CGSSetConnectionProperty") else {
            backgroundControl = false
            return false
        }
        let connection = unsafeBitCast(defaultSymbol, to: DefaultConnection.self)()
        let set = unsafeBitCast(setSymbol, to: SetConnectionProperty.self)
        let status = set(connection, connection, "SetsCursorInBackground" as CFString, kCFBooleanTrue)
        backgroundControl = status == 0
        return status == 0
    }

    /// Lease started: hide the arrow (balanced by `show`). Returns whether it is hidden now.
    ///
    /// 修复依据（2026-10-03 实测，截屏探针）：后台隐藏只在指针静止时有效；代理把指针滑到
    /// Calculator 按钮上的瞬间，前台应用的光标更新会让系统重新显示箭头。所以租约期间在每个
    /// 投递事件之后（`reassert`）立即再隐藏，并在其后 120 ms 内每 10 ms、静止时每 150 ms
    /// 再隐藏一次，直到租约结束（实测仅 150 ms 节拍时点击过程中仍有闪现）。
    @discardableResult
    static func hide() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !hidden else { return true }
        guard enableBackgroundControl() else { return false }
        guard CGDisplayHideCursor(CGMainDisplayID()) == .success else { return false }
        hidden = true
        hideCount = 1
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInteractive))
        timer.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10))
        timer.setEventHandler { onTick() }
        ticker = timer
        timer.resume()
        return true
    }

    /// After every posted event: hide again now and keep re-hiding densely for 120 ms.
    static func reassert() {
        lock.lock()
        defer { lock.unlock() }
        guard hidden else { return }
        burstUntil = Date().addingTimeInterval(0.12)
        if CGDisplayHideCursor(CGMainDisplayID()) == .success { hideCount += 1 }
    }

    private static func onTick() {
        lock.lock()
        defer { lock.unlock() }
        guard hidden else { return }
        tick &+= 1
        guard Date() < burstUntil || tick % 15 == 0 else { return }
        if CGDisplayHideCursor(CGMainDisplayID()) == .success { hideCount += 1 }
    }

    /// Lease ended (any reason): stop re-hiding and show the arrow as often as it was hidden.
    static func show() {
        lock.lock()
        defer { lock.unlock() }
        guard hidden else { return }
        hidden = false
        ticker?.cancel()
        ticker = nil
        for _ in 0..<hideCount { _ = CGDisplayShowCursor(CGMainDisplayID()) }
        hideCount = 0
    }
}
