// Evidence instrument — NOT product code, and deliberately outside the helper build.
//
// `build-dev-helper.mjs` compiles every `.swift` file in the helper directory, so this file lives
// in a subdirectory to keep it out of the shipped helper. It is compiled on demand by
// `run-observe-invariants.mjs`.
//
// It answers exactly one question, in the form the brief requires: what does the user's desktop
// look like right now? Specifically the three things a background capture must not disturb —
// which application is frontmost, where the hardware cursor is, and where the target window sits
// in the z-order. Recording it before and after an observation is what turns "observation never
// fronts anything" from a comment into a measurement.
//
// It reads only public state, requests no TCC permission, and prints one JSON object.

import AppKit
import CoreGraphics
import Foundation

let frontmost = NSWorkspace.shared.frontmostApplication
// CGEvent's location is in the top-left-origin coordinate space the window server (and therefore
// CGWindowBounds) uses, which is what makes it comparable with the window rows below.
let cursor = CGEvent(source: nil)?.location ?? CGPoint.zero

let rawWindows =
    (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
var windows: [[String: Any]] = []
for (zOrder, window) in rawWindows.enumerated() {
    guard (window[kCGWindowLayer as String] as? Int ?? -1) == 0 else { continue }
    let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    windows.append([
        "window_id": window[kCGWindowNumber as String] as? Int ?? -1,
        "pid": window[kCGWindowOwnerPID as String] as? Int ?? -1,
        "owner": window[kCGWindowOwnerName as String] as? String ?? "",
        "title": window[kCGWindowName as String] as? String ?? "",
        "z_order": zOrder,
        "on_screen": (window[kCGWindowIsOnscreen as String] as? Bool) ?? false,
        "width": Double(bounds["Width"] ?? 0),
        "height": Double(bounds["Height"] ?? 0),
    ])
}

let snapshot: [String: Any] = [
    "frontmost": [
        "bundleId": frontmost?.bundleIdentifier ?? "",
        "pid": Int(frontmost?.processIdentifier ?? 0),
        "name": frontmost?.localizedName ?? "",
    ],
    "cursor": ["x": Double(cursor.x), "y": Double(cursor.y)],
    "windowCount": windows.count,
    "windows": windows,
]

let data = try! JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
