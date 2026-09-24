import CoreGraphics
import Foundation

@main
struct ForegroundPolicyTests {
    static func main() {
        let own: Int64 = 123456
        check(!foregroundEventInterrupts(.mouseMoved, marker: own, currentMarker: own),
              "tagged pointer is ours")
        check(!foregroundEventInterrupts(.keyDown, marker: own, currentMarker: own),
              "tagged keyboard is ours")
        check(foregroundEventInterrupts(.leftMouseDown, marker: 0, currentMarker: own),
              "unmarked pointer interrupts")
        check(foregroundEventInterrupts(.keyDown, marker: 0, currentMarker: own),
              "unmarked keyboard interrupts")
        check(foregroundEventInterrupts(.scrollWheel, marker: own + 1, currentMarker: own),
              "another process's marker interrupts")
        check(foregroundEventInterrupts(.tapDisabledByTimeout, marker: own,
                                        currentMarker: own), "disabled tap interrupts")
        print("foreground event classification tests passed")
    }

    private static func check(_ value: @autoclosure () -> Bool, _ reason: String) {
        guard value() else {
            fputs("foreground policy failed: \(reason)\n", stderr)
            exit(1)
        }
    }
}
