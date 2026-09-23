// Typed Accessibility attribute readers.
//
// Deliberately thin: every reader returns nil rather than a default, because "the attribute is
// absent" and "the attribute is empty" mean different things to an observe-only caller, and
// collapsing them would make the tree lie.
//
// Every read passes the closed allowlist in `axReadableAttributes` (Observe.swift). The list is a
// guard here rather than a comment there, because the attributes this walk must never read are the
// ones that carry host locations — `AXDocument`, `AXFilename`, `AXURL` — and a single added
// `axString(element, kAXDocumentAttribute)` call would otherwise put the user's document paths into
// an observation without anything objecting.

import ApplicationServices
import CoreGraphics
import Foundation

func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    guard axReadableAttributes.contains(name) else {
        FileHandle.standardError.write(
            "ax: refused to read non-allowlisted attribute \(name)\n".data(using: .utf8)!)
        return nil
    }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = axAttribute(element, name) else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func axBool(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let value = axAttribute(element, name) else { return nil }
    if let flag = value as? Bool { return flag }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

func axPoint(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}
