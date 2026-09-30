// CUA-4 lease identity contract: the acquire-confirm envelope carries the SHORT identity,
// and the JS runtime's lease-authority commit requires helper_identity.requirement from it.
// shortIdentityJSON must therefore carry the same verified requirement the full report
// already contains — an attestation derived from the signature, never a credential.
//
// Run: ./run-identity-shape-tests.sh
import Foundation

// Minimal stub: CodeIdentity.swift's policy resolution references the launcher's Args type
// from main.swift, which cannot be compiled alongside an @main test (top-level code conflict).
// The identity-shape assertions below never read the process policy, so a stub suffices.
struct Args {
    let raw: [String]
    func string(_ name: String) -> String? {
        guard let i = raw.firstIndex(of: "--\(name)"), i + 1 < raw.count else { return nil }
        return raw[i + 1]
    }
    func has(_ name: String) -> Bool { raw.contains("--\(name)") }
}

struct IdentityShapeTests {
    static func main() {
        let report = CodeIdentityReport(
            verified: true,
            identifier: "dev.acevra.cua-helper",
            teamIdentifier: "TEAMXYZ1234",
            cdHash: "abcd1234abcd1234abcd1234abcd1234abcd1234",
            requirement: "identifier \"dev.acevra.cua-helper\" and anchor apple generic",
            adHoc: false,
            pid: 4242,
            expectedIdentifier: "dev.acevra.cua-helper",
            expectationSource: "launcher",
            bundleValidated: true,
            reason: "")

        let short = shortIdentityJSON(report)

        // The lease-commit consumer reads exactly this field from the short identity.
        check(short["requirement"] as? String == report.requirement,
              "short identity carries the verified requirement")

        // Existing short-identity fields stay intact.
        check(short["verified"] as? Bool == true, "verified preserved")
        check(short["identifier"] as? String == report.identifier, "identifier preserved")
        check(short["cd_hash"] as? String == report.cdHash, "cd_hash preserved")
        check(short["ad_hoc"] as? Bool == false, "ad_hoc preserved")
        check(short["pid"] as? Int == report.pid, "pid preserved")
        check(short["bundle_validated"] as? Bool == report.bundleValidated,
              "bundle_validated preserved")
        check(short["reason"] as? String == report.reason, "reason preserved")

        // bundle_validated and requirement attest the SAME verified report.
        let full = report.json
        check(full["requirement"] as? String == short["requirement"] as? String,
              "short and full requirement agree")
        check(full["bundle_validated"] as? Bool == short["bundle_validated"] as? Bool,
              "short and full bundle_validated agree")

        print("identity shape tests passed")
    }

    private static func check(_ value: @autoclosure () -> Bool, _ reason: String) {
        guard value() else {
            fputs("identity shape failed: \(reason)\n", stderr)
            exit(1)
        }
    }
}

@main
struct IdentityShapeTestsMain {
    static func main() { IdentityShapeTests.main() }
}
