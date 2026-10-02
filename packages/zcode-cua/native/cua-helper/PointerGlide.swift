// Visible agent pointer for exclusive foreground actions (specs/computer-use.md
// "Visible agent pointer"). Pure path math so deterministic tests can pin it; the Helper posts one
// tagged mouseMoved per point (its own marker, so the takeover is never interrupted by itself).

import CoreGraphics
import Foundation

/// Intermediate points from `start` to `end` (end included, start excluded) with ease-in-out
/// timing. Step count grows with distance so long travels stay smooth and short ones stay quick.
func pointerGlidePath(from start: CGPoint, to end: CGPoint) -> [CGPoint] {
    let distance = hypot(end.x - start.x, end.y - start.y)
    guard distance.isFinite, distance > 2 else { return [end] }
    let steps = max(6, min(30, Int(distance / 30)))
    return (1...steps).map { index in
        let t = Double(index) / Double(steps)
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        return CGPoint(x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased)
    }
}

/// Delay between glide steps: ~0.25–0.45 s per travel, visible without slowing actions much.
let pointerGlideStepSeconds: TimeInterval = 0.015
