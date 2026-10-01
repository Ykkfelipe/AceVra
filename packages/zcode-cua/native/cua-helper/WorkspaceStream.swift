// Human-only continuous window capture. No observations or background activation/physical input.
import AppKit
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

@available(macOS 12.3, *)
final class WorkspaceStream: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = WorkspaceStream()
    private let lock = NSRecursiveLock()
    private let output = DispatchQueue(label: "acevra.workspace.frames")
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    private var stream: SCStream?
    private var generation = ""
    private var pid: pid_t = 0
    private var windowId: UInt32 = 0
    private var seq = 0
    private var latest: [String: Any]?
    private var reason = "waiting_for_screen"
    private var lastRead = Date()
    private var lastCheck = Date.distantPast
    private var geometry = CGRect.zero
    private var verifiedWindow: SCWindow?
    private var pixelWidth = 0
    private var pixelHeight = 0
    private var watchdog: DispatchSourceTimer?

    private func shareable() -> SCShareableContent? {
        var result: SCShareableContent?
        var finished = false
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, _ in
            DispatchQueue.main.async {
                result = content; finished = true
                CFRunLoopStop(CFRunLoopGetMain())
            }
        }
        let deadline = Date().addingTimeInterval(2)
        while !finished && Date() < deadline { CFRunLoopRunInMode(.defaultMode, 0.1, false) }
        return result
    }

    func command(_ params: [String: Any]) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard let requested = params["generation"] as? String, !requested.isEmpty,
              requested.count <= 160, let operation = params["operation"] as? String,
              ["read", "stop", "take_control"].contains(operation) else {
            return ["status": "unavailable", "reason": "bad_request"]
        }
        if operation == "stop" {
            if requested == generation { stop("hidden") }
            return ["status": "unavailable", "reason": "hidden"]
        }
        guard let requestedPid = (params["pid"] as? NSNumber)?.int32Value, requestedPid > 0,
              let requestedWindow = (params["window_id"] as? NSNumber)?.uint32Value,
              requestedWindow >= 0 else {
            return ["status": "unavailable", "reason": "target_unavailable"]
        }
        let needsCheck = generation != requested || pid != requestedPid ||
            (requestedWindow > 0 && requestedWindow != windowId) || stream == nil ||
            Date().timeIntervalSince(lastCheck) > 0.75 || operation == "take_control"
        if needsCheck {
            lastCheck = Date()
            guard let content = shareable() else {
                stop("permission_or_capture_unavailable")
                return ["status": "unavailable", "reason": reason]
            }
            // SCK 会继续列出已经 close 的窗口并保留末帧；活跃 AX 窗口必须同时确认存活。
            let liveFrames = WorkspaceController.targetWindowFrames(pid: requestedPid)
            let targetFrame = liveFrames.first ?? nil
            verifiedWindow = content.windows.first(where: {
                $0.owningApplication?.processID == requestedPid &&
                liveFrames.contains($0.frame) &&
                (requestedWindow > 0 ? $0.windowID == requestedWindow : $0.frame == targetFrame)
            })
        }
        guard let targetWindow = verifiedWindow else {
            stop("target_lost")
            return ["status": "unavailable", "reason": "target_lost", "generation": requested]
        }
        let resolvedWindow = targetWindow.windowID
        if operation == "take_control" {
            // 用户显式接管只激活已验证目标，不创建 agent 的 EXCLUSIVE_FOREGROUND 租约。
            guard let app = NSRunningApplication(processIdentifier: requestedPid) else {
                return ["status": "unavailable", "reason": "target_lost"]
            }
            return ["status": app.activate(options: []) ? "available" : "unavailable"]
        }
        lastRead = Date()
        let changed = generation != requested || pid != requestedPid || windowId != resolvedWindow
        if changed || needsCheck {
            let window = targetWindow
            if changed || stream == nil {
                stop("waiting_for_screen")
                generation = requested; pid = requestedPid; windowId = resolvedWindow
                geometry = window.frame
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let config = configuration(window.frame)
                let capture = SCStream(filter: filter, configuration: config, delegate: self)
                do { try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: output) }
                catch { return ["status": "unavailable", "reason": "capture_unavailable"] }
                stream = capture
                var started = false
                var startError: Error?
                capture.startCapture { error in
                    DispatchQueue.main.async {
                        startError = error; started = true
                        CFRunLoopStop(CFRunLoopGetMain())
                    }
                }
                let deadline = Date().addingTimeInterval(2)
                while !started && Date() < deadline { CFRunLoopRunInMode(.defaultMode, 0.1, false) }
                if startError != nil || !started {
                    stop("permission_or_capture_unavailable")
                    return ["status": "unavailable", "reason": reason]
                }
                let timer = DispatchSource.makeTimerSource(queue: output)
                timer.schedule(deadline: .now() + 2, repeating: 1)
                timer.setEventHandler { [weak self] in
                    guard let self else { return }
                    self.lock.lock(); defer { self.lock.unlock() }
                    guard Date().timeIntervalSince(self.lastRead) > 3 else { return }
                    self.stop("viewer_expired")
                }
                watchdog = timer; timer.resume()
            } else if geometry.size != window.frame.size {
                geometry = window.frame
                // 配置更新前排队的旧尺寸像素不能配上新窗口几何；等待尺寸一致的新帧。
                latest = nil; reason = "waiting_for_screen"
                stream?.updateConfiguration(configuration(window.frame)) { _ in }
            } else { geometry = window.frame }
        }
        lock.lock(); defer { lock.unlock() }
        var result = latest ?? ["status": "unavailable", "reason": reason]
        result["generation"] = generation
        result["pid"] = Int(pid); result["windowId"] = Int(windowId)
        result["originX"] = geometry.origin.x; result["originY"] = geometry.origin.y
        result["pointWidth"] = geometry.width; result["pointHeight"] = geometry.height
        if let after = params["after_seq"] as? Int, after == seq { result.removeValue(forKey: "jpeg") }
        return result
    }

    private func configuration(_ rect: CGRect) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        let scale = min(1, 1280 / max(1, max(rect.width, rect.height)))
        config.width = max(2, Int(rect.width * scale))
        config.height = max(2, Int(rect.height * scale))
        pixelWidth = config.width; pixelHeight = config.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 12)
        config.queueDepth = 3
        config.showsCursor = false
        config.pixelFormat = kCVPixelFormatType_32BGRA
        return config
    }

    private func stop(_ why: String) {
        lock.lock(); defer { lock.unlock() }
        let previous = stream
        stream = nil
        watchdog?.cancel(); watchdog = nil
        lock.lock(); latest = nil; seq = 0; reason = why; lock.unlock()
        previous?.stopCapture { _ in }
    }

    func stream(_ stopped: SCStream, didStopWithError error: Error) {
        lock.lock(); defer { lock.unlock() }
        guard stopped === stream else { return }
        stop("capture_unavailable")
    }

    func stream(_ capture: SCStream, didOutputSampleBuffer sample: CMSampleBuffer,
                of type: SCStreamOutputType) {
        lock.lock(); defer { lock.unlock() }
        guard type == .screen, capture === stream,
              let buffer = CMSampleBufferGetImageBuffer(sample),
              CVPixelBufferGetWidth(buffer) == pixelWidth,
              CVPixelBufferGetHeight(buffer) == pixelHeight else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]], let raw = attachments.first?[.status] as? Int,
            raw != SCFrameStatus.complete.rawValue { return }
        let age = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) -
            CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
        let capturedAt = Date().timeIntervalSince1970 * 1000 - max(0, age.isFinite ? age * 1000 : 0)
        autoreleasepool {
            let ci = CIImage(cvPixelBuffer: buffer)
            guard let cg = imageContext.createCGImage(ci, from: ci.extent) else { return }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString,
                1, nil) else { return }
            CGImageDestinationAddImage(destination, cg,
                [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
            guard CGImageDestinationFinalize(destination), data.length <= 1_500_000,
                  capture === stream else { return }
            lock.lock(); defer { lock.unlock() }
            seq += 1
            latest = ["status": "available", "seq": seq, "capturedAt": capturedAt,
                      "width": cg.width, "height": cg.height,
                      "jpeg": (data as Data).base64EncodedString()]
        }
    }
}

func workspaceStreamCommand(_ params: [String: Any]) -> [String: Any] {
    guard cuaHostConnectSessionActive else {
        return ["status": "unavailable", "reason": "not_authorized"]
    }
    if #available(macOS 12.3, *) { return WorkspaceStream.shared.command(params) }
    return ["status": "unavailable", "reason": "unsupported_platform"]
}
