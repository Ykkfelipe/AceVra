// Pure policy shared by the AX adapter and deterministic command-line tests.
import CoreFoundation
import Foundation

let semanticPressRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
]
let semanticValueRoles: Set<String> = ["AXTextField", "AXTextArea", "AXCheckBox", "AXSlider"]
let semanticValueLimit = 4096

func semanticLabelIsDisallowed(_ label: String) -> Bool {
    let terms = [
        "delete", "remove", "erase", "quit", "close", "exit", "shutdown", "format",
        "purchase", "buy", "supprimer", "effacer", "löschen", "entfernen", "删除", "移除", "清除", "购买", "終了", "削除",
    ]
    return terms.contains(where: { label.localizedCaseInsensitiveContains($0) })
}

func semanticPressRefusal(role: String, enabled: Bool?, advertised: Bool,
                          labelIsDisallowed: Bool) -> String? {
    guard semanticPressRoles.contains(role) else { return "unsupported_role" }
    guard enabled == true else { return "not_authorized" }
    guard advertised else { return "action_not_supported" }
    return labelIsDisallowed ? "not_authorized" : nil
}

func semanticSetValueRefusal(role: String, enabled: Bool?, settable: Bool?, value: Any,
                             labelIsDisallowed: Bool = false) -> String? {
    guard semanticValueRoles.contains(role) else { return "unsupported_role" }
    guard enabled == true else { return "not_authorized" }
    guard !labelIsDisallowed else { return "not_authorized" }
    switch role {
    case "AXTextField", "AXTextArea":
        guard let string = value as? String else { return "invalid_value" }
        guard string.count <= semanticValueLimit else { return "oversized_value" }
    case "AXCheckBox":
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return "invalid_value" }
    case "AXSlider":
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return "invalid_value" }
    default:
        return "unsupported_role"
    }
    guard settable == true else { return "attribute_read_only" }
    return nil
}

func semanticActionEffect(apiSucceeded: Bool, stateVerified: Bool, invariantsHeld: Bool) -> String {
    guard invariantsHeld else { return "partial" }
    if stateVerified { return "confirmed" }
    return apiSucceeded ? "unknown" : "failed"
}
