import Foundation

@main
struct SemanticActionPolicyTests {
    static func main() {
        expect(semanticPressRefusal(role: "AXButton", enabled: true, advertised: true,
                                    labelIsDisallowed: semanticLabelIsDisallowed("Run")) == nil,
               "permitted advertised AXPress")
        expect(semanticPressRefusal(role: "AXTextField", enabled: true, advertised: true,
                                    labelIsDisallowed: false) == "unsupported_role",
               "unsupported press role")
        expect(semanticPressRefusal(role: "AXButton", enabled: true, advertised: false,
                                    labelIsDisallowed: false) == "action_not_supported",
               "unadvertised action")
        expect(semanticPressRefusal(role: "AXButton", enabled: true, advertised: true,
                                    labelIsDisallowed: semanticLabelIsDisallowed("Delete file")) == "not_authorized",
               "destructive label")
        expect(semanticLabelIsDisallowed("删除账户"), "localized destructive label")
        expect(semanticSetValueRefusal(role: "AXTextField", enabled: true, settable: true, value: "text") == nil,
               "writable text field")
        expect(semanticSetValueRefusal(role: "AXTextField", enabled: true, settable: false, value: "text") == "attribute_read_only",
               "read-only attribute")
        expect(semanticSetValueRefusal(role: "AXTextField", enabled: true, settable: true, value: 4) == "invalid_value",
               "wrong value type")
        expect(semanticSetValueRefusal(role: "AXTextField", enabled: true, settable: true,
                                       value: String(repeating: "x", count: semanticValueLimit + 1)) == "oversized_value",
               "oversized string")
        expect(semanticSetValueRefusal(role: "AXCheckBox", enabled: true, settable: true, value: NSNumber(value: 1)) == "invalid_value",
               "checkbox rejects numeric value")
        expect(semanticSetValueRefusal(role: "AXCheckBox", enabled: true, settable: true, value: NSNumber(value: true)) == nil,
               "checkbox accepts boolean value")
        expect(semanticSetValueRefusal(role: "AXSlider", enabled: true, settable: true, value: Double.infinity) == "invalid_value",
               "slider rejects non-finite value")
        expect(semanticSetValueRefusal(role: "AXStaticText", enabled: true, settable: true, value: "x") == "unsupported_role",
               "set_value rejects unsupported role")
        expect(semanticActionEffect(apiSucceeded: true, stateVerified: false, invariantsHeld: true) == "unknown",
               "API success without post-state proof is unknown")
        expect(semanticActionEffect(apiSucceeded: true, stateVerified: true, invariantsHeld: true) == "confirmed",
               "verified state confirms action")
        expect(semanticActionEffect(apiSucceeded: true, stateVerified: true, invariantsHeld: false) == "partial",
               "foreground invariant change prevents confirmation")
        expect(semanticActionEffect(apiSucceeded: false, stateVerified: false, invariantsHeld: true) == "failed",
               "unverified API failure is failed")
        print("semantic action policy tests passed")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
        guard condition() else {
            fputs("semantic policy test failed: \(name)\n", stderr)
            exit(1)
        }
    }
}
