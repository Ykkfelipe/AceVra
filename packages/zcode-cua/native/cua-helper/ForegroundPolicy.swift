import CoreGraphics

// Pure classification so deterministic tests can prove our own tagged events never interrupt.
// A marker classifies events; it grants no lease or actuation authority.
func foregroundEventInterrupts(_ type: CGEventType, marker: Int64,
                               currentMarker: Int64?) -> Bool {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return true }
    guard let currentMarker else { return false }
    return marker != currentMarker
}
