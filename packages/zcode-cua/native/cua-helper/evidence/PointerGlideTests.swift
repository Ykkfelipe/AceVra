import CoreGraphics
import Foundation

// Run: packages/zcode-cua/native/cua-helper/run-pointer-glide-tests.sh
@main
struct PointerGlideTests {
    static func main() {
        let start = CGPoint(x: 100, y: 100)
        let end = CGPoint(x: 700, y: 400)
        let path = pointerGlidePath(from: start, to: end)
        check(path.count >= 6 && path.count <= 30, "bounded step count")
        check(path.last == end, "the glide ends exactly on the target")
        var last = start
        for point in path {
            check(hypot(point.x - start.x, point.y - start.y) >= hypot(last.x - start.x, last.y - start.y),
                  "monotonic travel toward the target")
            last = point
        }
        let first = path[0]
        let mid = path[path.count / 2]
        check(hypot(first.x - start.x, first.y - start.y) < hypot(mid.x - path[path.count / 2 - 1].x,
                                                                   mid.y - path[path.count / 2 - 1].y),
              "ease-in: the first step is shorter than a middle step")
        check(pointerGlidePath(from: start, to: CGPoint(x: 101, y: 100)) == [CGPoint(x: 101, y: 100)],
              "a tiny move is a single step")
        check(Double(path.count) * pointerGlideStepSeconds <= 0.5, "a glide stays under half a second")
        print("pointer glide tests passed")
    }

    private static func check(_ value: @autoclosure () -> Bool, _ reason: String) {
        guard value() else {
            fputs("pointer glide failed: \(reason)\n", stderr)
            exit(1)
        }
    }
}
