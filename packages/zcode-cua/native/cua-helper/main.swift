// ZCode Computer Use — development helper (CUA-0.5 permission/identity proof).
//
// Scope: this binary exists ONLY to prove the macOS permission and code-identity
// foundation for the first-party CUA helper. It deliberately implements NO input:
// no synthetic mouse events, no keystrokes, no pointer movement. The capabilities
// kept here are the ones the permission contract must be able to evaluate:
//
//   1. report permission state (Accessibility trust, Screen Recording preflight)
//   2. enumerate running applications (trivial, no TCC needed)
//   3. perform a harmless Accessibility read against a target pid
//   4. capture a window/display through ScreenCaptureKit and prove it is not blank
//   5. self-report the code identity it actually runs as (cdhash + designated
//      requirement), so every archived run is attributable without extra tooling
//
// It honours the launch contract already declared by @zcode/zcode-cua:
// `buildHelperOpenArgs(spec, launcherPid)` produces `/usr/bin/open` arguments, so the
// helper receives `--launcher-pid <pid>` from the ZCode main process. The helper treats
// that value as a peer-to-verify, never as an identity to inherit; which identity macOS
// actually attributes the grants to is exactly what this build exists to measure.
//
// Build: packages/zcode-cua/native/cua-helper/build-dev-helper.mjs

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// MARK: - Argument parsing

/// Tiny flag parser. The helper takes only the flags the permission proof needs; the
/// full launch spec belongs to the real helper, not to this one.
struct Args {
    let raw: [String]
    func string(_ name: String) -> String? {
        guard let i = raw.firstIndex(of: "--\(name)"), i + 1 < raw.count else { return nil }
        return raw[i + 1]
    }
    func int(_ name: String) -> Int? { string(name).flatMap(Int.init) }
    func has(_ name: String) -> Bool { raw.contains("--\(name)") }
}

let args = Args(raw: Array(CommandLine.arguments.dropFirst()))

// MARK: - Output

var reportPath: String? = args.string("report")

func emit(_ object: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(
            withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return }
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
    if let path = reportPath {
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

/// Run a command and return its combined output, or nil. Used only to let the helper
/// describe its own signature; failure is never fatal.
func runTool(_ launchPath: String, _ argv: [String]) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = argv
    let pipe = Pipe()
    // Both streams share one pipe: codesign writes its diagnostics to stderr, and the
    // helper must record its own cdhash/requirement, not an empty string.
    process.standardOutput = pipe
    process.standardError = pipe
    guard (try? process.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return (text?.isEmpty ?? true) ? nil : text
}

// MARK: - 1. Permission state

/// Accessibility trust as seen by THIS process. `AXIsProcessTrusted` is the same
/// predicate the AX server uses to decide whether to serve this process, so it is the
/// honest signal rather than "the toggle looks green in System Settings".
func accessibilityTrusted() -> Bool { AXIsProcessTrusted() }

/// Ask the system to surface the Accessibility prompt for this process. This only
/// *registers* this bundle in the TCC list; the user still has to switch it on.
func requestAccessibilityPrompt() -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    return AXIsProcessTrustedWithOptions(options as CFDictionary)
}

// MARK: - 2. Application enumeration

func runningAppSummaries() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { app in
            guard let bundleId = app.bundleIdentifier else { return nil }
            return [
                "bundleId": bundleId,
                "name": app.localizedName ?? "",
                "pid": Int(app.processIdentifier),
                "active": app.isActive,
            ]
        }
}

// MARK: - 3. Harmless Accessibility read

func axRead(targetPid: pid_t) -> [String: Any] {
    let app = AXUIElementCreateApplication(targetPid)
    AXUIElementSetMessagingTimeout(app, 3.0)
    var windowsValue: CFTypeRef?
    var result: [String: Any] = ["targetPid": Int(targetPid)]
    let windowsStatus = AXUIElementCopyAttributeValue(
        app, kAXWindowsAttribute as CFString, &windowsValue)
    result["windowsStatus"] = Int(windowsStatus.rawValue)
    guard windowsStatus == .success, let windows = windowsValue as? [AXUIElement],
        let first = windows.first
    else {
        // windowsStatus is non-zero: the AX server refused this process.
        result["ok"] = false
        result["refused"] = true
        return result
    }
    var titleValue: CFTypeRef?
    let titleStatus = AXUIElementCopyAttributeValue(
        first, kAXTitleAttribute as CFString, &titleValue)
    // `ok` means "the AX server served this process", which is the permission-relevant
    // fact. Whether a particular window happens to expose a title is a property of the
    // target app, not of our authorization, so it is reported separately — conflating the
    // two previously made a granted helper look denied.
    result["ok"] = true
    result["titleOk"] = titleStatus == .success
    result["windowCount"] = windows.count
    result["windowTitle"] = (titleValue as? String) ?? ""
    return result
}

// MARK: - 4. Screen capture (exercises the real Screen Recording path)

/// Legacy-ish preflight: cheap, and answers "has the user granted Screen Recording to
/// this identity" without producing a frame.
func screenCapturePreflight() -> Bool { CGPreflightScreenCaptureAccess() }

/// Ask the system to surface the Screen Recording prompt for this process. Like the
/// Accessibility equivalent this only *registers* the bundle in the TCC list; the user
/// still has to switch it on.
func requestScreenRecordingPrompt() -> Bool { CGRequestScreenCaptureAccess() }

/// Capture the main display through ScreenCaptureKit and report whether real pixels
/// came back. `CGPreflightScreenCaptureAccess` can be true while a capture still fails,
/// and a capture with no permission yields a black frame rather than an error, so the
/// distinct-colour count is what distinguishes "granted" from "silently blank".
@available(macOS 14.0, *)
func captureDisplay(sampleStride: Int = 97) -> [String: Any] {
    _ = NSApplication.shared  // ScreenCaptureKit needs a GUI connection first.
    var finished: [String: Any]?
    func finish(_ value: [String: Any]) {
        DispatchQueue.main.async {
            finished = value
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) {
        content, error in
        guard let content, let display = content.displays.first else {
            finish([
                "ok": false,
                "error": "shareableContent: \(error?.localizedDescription ?? "no display")",
            ])
            return
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
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
            let distinct = distinctColorCount(image, stride: sampleStride)
            finish([
                "ok": true,
                "width": image.width,
                "height": image.height,
                "distinctSampledColors": distinct,
                // One colour across the whole frame is the signature of a
                // permission-denied (or entirely uniform) capture.
                "blank": distinct <= 1,
            ])
        }
    }
    CFRunLoopRun()
    return finished ?? ["ok": false, "error": "timed out"]
}

/// Count distinct RGBA values over a strided grid of pixels. Deliberately cheap: it is
/// evidence that a real frame arrived, not image analysis.
func distinctColorCount(_ image: CGImage, stride: Int) -> Int {
    let width = image.width
    let height = image.height
    guard width > 0, height > 0 else { return 0 }
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let space = CGColorSpaceCreateDeviceRGB()
    guard
        let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return 0 }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    var seen = Set<UInt32>()
    var y = 0
    while y < height {
        var x = 0
        while x < width {
            let offset = (y * width + x) * 4
            let packed =
                UInt32(pixels[offset]) << 24 | UInt32(pixels[offset + 1]) << 16
                | UInt32(pixels[offset + 2]) << 8 | UInt32(pixels[offset + 3])
            seen.insert(packed)
            if seen.count > 64 { return seen.count }
            x += stride
        }
        y += stride
    }
    return seen.count
}

// MARK: - 5. Own code identity

/// The code identity this process is actually running as. The designated requirement is
/// the thing TCC keys a grant on; the cdhash is what changes on every rebuild. Recording
/// both per run is what makes a rebuild-then-still-granted claim checkable.
func codeIdentity() -> [String: Any] {
    let bundlePath = Bundle.main.bundlePath
    var info: [String: Any] = [
        "bundlePath": bundlePath,
        "bundleId": Bundle.main.bundleIdentifier ?? "",
        "executablePath": Bundle.main.executablePath ?? "",
        "pid": Int(getpid()),
        "ppid": Int(getppid()),
    ]
    if let requirement = runTool("/usr/bin/codesign", ["-d", "-r-", bundlePath]) {
        // `-d -r-` prints an "Executable=..." line first and the requirement second;
        // pick the requirement line explicitly rather than trusting the ordering.
        let requirementLines = requirement.split(separator: "\n").map(String.init)
        let line = requirementLines.first { $0.contains("=>") } ?? requirement
        info["designatedRequirement"] = line
            .replacingOccurrences(of: "designated => ", with: "")
            .replacingOccurrences(of: "designated =>", with: "")
            .trimmingCharacters(in: CharacterSet.whitespaces)
    }
    // A Developer-ID signature reports `CDHash=`; a self-signed one only reports
    // CandidateCDHash{,Full} at -v3 or above. Record whichever exists — the cdhash is
    // the value that changes on every rebuild, so it must be present to make a
    // "rebuilt but still granted" claim checkable.
    if let details = runTool("/usr/bin/codesign", ["-dv", "--verbose=3", bundlePath]) {
        for line in details.split(separator: "\n") {
            if line.hasPrefix("CDHash=") {
                info["cdHash"] = String(line.dropFirst("CDHash=".count))
            } else if let range = line.range(of: "CandidateCDHashFull sha256=") {
                info["cdHash"] = String(line[range.upperBound...])
            } else if let range = line.range(of: "CandidateCDHash sha256="),
                info["cdHash"] == nil
            {
                info["cdHash"] = String(line[range.upperBound...])
            }
        }
    }
    return info
}

// MARK: - Watch mode (Step 7: what must restart after a grant)

/// Poll the permission state and append one compact JSON line per sample.
///
/// This exists to answer a question a single reading cannot: when the user grants a
/// permission while a helper is already running, does THAT process observe it, or does
/// macOS only serve the new answer to a fresh process? The answer is what the settings
/// UI must tell the user ("Restart Helper" versus "no restart needed"), so it is measured
/// rather than assumed.
func watchPermissionState(
    reportPath: String, seconds: Double, intervalMs: Int, withCapture: Bool
) -> Never {
    FileManager.default.createFile(atPath: reportPath, contents: nil)
    guard let handle = FileHandle(forWritingAtPath: reportPath) else {
        FileHandle.standardError.write("watch: cannot open report path\n".data(using: .utf8)!)
        exit(1)
    }
    let deadline = Date().addingTimeInterval(seconds)
    var index = 0
    while Date() < deadline {
        var sample: [String: Any] = [
            "i": index,
            "t": ISO8601DateFormatter().string(from: Date()),
            "pid": Int(getpid()),
            // The identity the sample was taken under: without it a series cannot be tied
            // to a bundle id or a code requirement, and attribution rests on pid alone.
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "ppid": Int(getppid()),
            "cdHash": codeIdentity()["cdHash"] ?? "",
            "requirement": codeIdentity()["designatedRequirement"] ?? "",
            "ax": accessibilityTrusted(),
            "srPreflight": screenCapturePreflight(),
        ]
        if withCapture, #available(macOS 14.0, *) {
            let capture = captureDisplay(sampleStride: 211)
            sample["captureOk"] = capture["ok"]
            sample["captureBlank"] = capture["blank"]
            sample["captureError"] = capture["error"]
        }
        if let data = try? JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys]),
            let line = String(data: data, encoding: .utf8)
        {
            handle.write((line + "\n").data(using: .utf8)!)
            handle.synchronizeFile()
        }
        index += 1
        Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
    }
    exit(0)
}

// MARK: - Report

// JSONSerialization rejects a nil value, so optional entries are added rather than
// written as nil into the literal.
var permissionReport: [String: Any] = [
    "accessibility": accessibilityTrusted(),
    "screenCapturePreflight": screenCapturePreflight(),
    "platform": ProcessInfo.processInfo.operatingSystemVersionString,
    "osMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
]
if args.has("request-accessibility") {
    permissionReport["accessibilityPromptRequested"] = requestAccessibilityPrompt()
}
if args.has("request-screen-recording") {
    permissionReport["screenRecordingPromptRequested"] = requestScreenRecordingPrompt()
}

var report: [String: Any] = [
    "schemaVersion": 1,
    "probe": "cua-helper-dev",
    "identity": codeIdentity(),
    "launch": [
        "argv": Array(CommandLine.arguments),
        // The value ZCode publishes as ZCODE_CUA_LAUNCHER_PID and passes through
        // buildHelperOpenArgs; recorded verbatim, never trusted as an identity.
        "launcherPidArg": args.int("launcher-pid") ?? -1,
        "parentPid": Int(getppid()),
    ],
    "permissions": permissionReport,
    "apps": runningAppSummaries(),
]

if let watchSeconds = args.int("watch-seconds"), let path = reportPath {
    watchPermissionState(
        reportPath: path,
        seconds: Double(watchSeconds),
        intervalMs: args.int("watch-interval-ms") ?? 1000,
        withCapture: args.has("capture"))
}

if let pidText = args.string("ax-read-pid"), let pid = Int32(pidText) {
    report["axRead"] = axRead(targetPid: pid)
}

if args.has("capture") {
    if #available(macOS 14.0, *) {
        report["capture"] = captureDisplay()
    } else {
        report["capture"] = ["ok": false, "error": "ScreenCaptureKit capture needs macOS 14+"]
    }
}

emit(report)

// Stay alive briefly so the launcher's health probe can find a live process, mirroring
// the real helper's "launched, then consulted" lifecycle.
if let idleMs = args.int("idle-ms"), idleMs > 0 {
    Thread.sleep(forTimeInterval: Double(idleMs) / 1000.0)
}
