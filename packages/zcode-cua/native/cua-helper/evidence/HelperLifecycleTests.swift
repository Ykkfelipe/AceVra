import Foundation

// Deterministic proof of the Helper lifetime policy (HelperLifecycle.swift).
// Run: packages/zcode-cua/native/cua-helper/run-helper-lifecycle-tests.sh
@main
struct HelperLifecycleTests {
    static func main() {
        // State derivation.
        check(helperLifecycleState(leaseActive: false, leaseEnding: false, msSinceActivity: 20_000,
                                   idleMs: 15_000) == .idle, "no lease past idle window is IDLE")
        check(helperLifecycleState(leaseActive: false, leaseEnding: false, msSinceActivity: 1_000,
                                   idleMs: 15_000) == .backgroundActive,
              "recent request without lease is BACKGROUND_ACTIVE")
        check(helperLifecycleState(leaseActive: true, leaseEnding: false, msSinceActivity: 600_000,
                                   idleMs: 15_000) == .protectedActive,
              "a lease is PROTECTED_ACTIVE however long the Helper has been idle")
        check(helperLifecycleState(leaseActive: false, leaseEnding: true, msSinceActivity: 600_000,
                                   idleMs: 15_000) == .protectedEnding,
              "tearing down a lease is PROTECTED_ENDING")
        check(helperLifecycleState(leaseActive: false, leaseEnding: false, msSinceActivity: 600_000,
                                   idleMs: 0) == .backgroundActive,
              "no idle timer configured never yields IDLE")

        // Idle exit: only IDLE may be ended by the generic idle timer (the old 15 s path).
        check(helperMayExitOnIdle(.idle), "IDLE keeps the existing idle exit")
        check(!helperMayExitOnIdle(.backgroundActive), "BACKGROUND_ACTIVE does not idle-exit")
        check(!helperMayExitOnIdle(.protectedActive),
              "PROTECTED_ACTIVE must not exit because a generic idle timer elapsed")
        check(!helperMayExitOnIdle(.protectedEnding), "PROTECTED_ENDING waits for cleanup")

        // Host disconnect.
        check(hostDisconnectAction(.idle) == .exit, "unprotected host EOF exits (old behavior)")
        check(hostDisconnectAction(.backgroundActive) == .exit, "background host EOF exits")
        check(hostDisconnectAction(.protectedActive)
                == .reconnectWithinGrace(graceMs: protectedReconnectGraceMs),
              "protected host EOF enters bounded reconnect grace")
        check(hostDisconnectAction(.protectedEnding) == .finishEndingThenExit,
              "ending host EOF finishes cleanup then exits")

        // Bounds: the grace is finite, below the host's 10 s admission wait, and cleanup is bounded.
        check(protectedReconnectGraceMs > 0 && protectedReconnectGraceMs < 10_000,
              "grace is bounded and shorter than the host admission wait")
        check(protectedEndingSafetyMs > 0 && protectedEndingSafetyMs <= 5_000,
              "PROTECTED_ENDING has a safety timeout")

        // Fencing codes are the canonical ones the runtime understands.
        check(reconnectFencedLeaseCode == "connection_generation_changed",
              "a reconnect fences the old lease generation")
        check(graceExpiredLeaseCode == "host_disconnected",
              "grace expiry ends the lease as host_disconnected")
        print("helper lifecycle policy tests passed")
    }

    private static func check(_ value: @autoclosure () -> Bool, _ reason: String) {
        guard value() else {
            fputs("helper lifecycle policy failed: \(reason)\n", stderr)
            exit(1)
        }
    }
}
