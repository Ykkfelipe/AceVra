// Bundle-validity measurement probe (CUA-1.5 evidence instrument — NOT part of the helper).
//
// Lives in evidence/ deliberately: build-dev-helper.mjs compiles every top-level .swift file in
// the cua-helper directory, and this tool must never ship inside the helper. It answers, with the
// platform's own API rather than assumptions, exactly what SecStaticCodeCheckValidity covers for
// the helper bundle shapes CUA-1.5 hardens:
//
//   1. which on-disk path the RUNNING code of a bundle executable resolves to
//      (SecCodeCopySelf → SecCodeCopyStaticCode → SecCodeCopyPath) — CUA-1 validated that path,
//      and the spec's remaining-gaps note says an added bundle resource was NOT detected, which
//      is only possible if that path is the executable image rather than the .app;
//   2. what SecStaticCodeCheckValidity accepts and refuses for the .app bundle itself under the
//      flag combinations in play, against tampered sealed resources, added files, edited code
//      and appended code.
//
// Every mode prints exactly one JSON object per line so the driving shell script can archive
// machine-readable evidence.
//
// Build: run-bundle-validity-probe.sh (arm64, links Security only).

import Foundation
import Security

func flags(_ allArch: Bool, _ strict: Bool, _ nested: Bool) -> SecCSFlags {
    var raw: UInt32 = 0
    if allArch { raw |= UInt32(kSecCSCheckAllArchitectures) }  // 1 << 0
    if nested { raw |= UInt32(kSecCSCheckNestedCode) }  // 1 << 3
    if strict { raw |= UInt32(kSecCSStrictValidate) }  // 1 << 4
    return SecCSFlags(rawValue: raw)
}

/// Validate one on-disk code object (executable or bundle) and report the OSStatus verdict.
func validate(path: String, allArch: Bool, strict: Bool, nested: Bool, requirementText: String)
    -> [String: Any]
{
    let url = URL(fileURLWithPath: path)
    var code: SecStaticCode?
    let openStatus = SecStaticCodeCreateWithPath(url as CFURL, [], &code)
    guard openStatus == errSecSuccess, let code else {
        return [
            "path": path, "ok": false, "status": Int(openStatus),
            "error": "SecStaticCodeCreateWithPath failed",
        ]
    }
    var requirement: SecRequirement?
    if !requirementText.isEmpty {
        SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
        // An unparsable requirement must not silently degrade into "no requirement": report it.
        if requirement == nil {
            return [
                "path": path, "ok": false, "status": -1,
                "error": "requirement text is not a valid code requirement",
            ]
        }
    }
    let status = SecStaticCodeCheckValidity(code, flags(allArch, strict, nested), requirement)
    return ["path": path, "ok": status == errSecSuccess, "status": Int(status), "error": ""]
}

/// Which path does the RUNNING code of this process resolve to, and does the executable-shaped
/// validation of that path pass? Run from inside a bundle executable, this is the measurement
/// behind CUA-1's "executable image, not sealed resources" scope note.
func selfReport() -> [String: Any] {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else {
        return ["mode": "self", "error": "SecCodeCopySelf failed"]
    }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
        return ["mode": "self", "error": "SecCodeCopyStaticCode failed"]
    }
    var url: CFURL?
    guard SecCodeCopyPath(staticCode, [], &url) == errSecSuccess, let url else {
        return ["mode": "self", "error": "SecCodeCopyPath failed"]
    }
    let resolvedPath = (url as URL).path
    var dynamicValidity: OSStatus = -1
    // Also validate the dynamic code the way the helper does, and re-open the resolved path as a
    // fresh static code — that pair is CUA-1's self-check verbatim.
    dynamicValidity = SecCodeCheckValidity(code, flags(false, true, false), nil)
    let reopened = validate(
        path: resolvedPath, allArch: true, strict: true, nested: false, requirementText: "")
    return [
        "mode": "self",
        "resolved_path": resolvedPath,
        "path_is_bundle": resolvedPath.hasSuffix(".app") || resolvedPath.hasSuffix(".bundle"),
        "dynamic_strict_status": Int(dynamicValidity),
        "reopened_validation": reopened,
    ]
}

func arg(_ name: String) -> String? {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func emit(_ object: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return }
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

if arg("mode") == "self" {
    emit(selfReport())
} else if let path = arg("validate") {
    let requirement = arg("requirement") ?? ""
    let allArch = CommandLine.arguments.contains("--all-arch")
    let strict = CommandLine.arguments.contains("--strict")
    let nested = CommandLine.arguments.contains("--nested")
    emit(validate(path: path, allArch: allArch, strict: strict, nested: nested, requirementText: requirement))
} else {
    FileHandle.standardError.write(
        "usage: BundleValidityProbe --self-report | --validate <path> [--requirement <dr>] [--all-arch] [--strict] [--nested]\n"
            .data(using: .utf8)!)
    exit(2)
}
