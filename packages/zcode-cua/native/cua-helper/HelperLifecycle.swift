// Helper lifetime policy (specs/computer-use.md "Helper lifetime and protected disconnect").
//
// Pure decisions only, so deterministic tests can prove them without a GUI session
// (evidence/HelperLifecycleTests.swift, run-helper-lifecycle-tests.sh). The process-level effects
// (serving, reconnecting, releasing the lease, exiting) live in BrokerServer.swift and
// ForegroundControl.swift and consult these functions.
//
// Safety invariant: an AceVra failure returns control to the user. A Helper never keeps
// protected state past a bounded grace once its authoritative host is gone.

import Foundation

enum HelperLifecycleState: String {
    /// No lease and no recent request: the existing idle-exit behavior applies (bind mode).
    case idle
    /// Serving background requests; the existing lightweight lifecycle applies.
    case backgroundActive = "background_active"
    /// Holding an exclusive desktop lease. Never exits because a generic idle timer elapsed.
    case protectedActive = "protected_active"
    /// Tearing a lease down. Stays alive until cleanup completes or the safety timeout fires.
    case protectedEnding = "protected_ending"
}

/// Bounded reconnect grace after the host transport disappears during PROTECTED_ACTIVE.
///
/// 8 s is deliberately below the host's 10 s admission wait (darwinCuaHelperTransport.ts), so a
/// relaunching host never waits on a Helper that is about to give up, and it is short enough that
/// a vanished AceVra cannot hold the desktop exclusion for long. During the grace the Helper has
/// already released every synthetic key/button it was holding, so the user's input is never
/// blocked; the lease only keeps the single-desktop exclusion while a reconnect is possible.
let protectedReconnectGraceMs = 8_000

/// Upper bound on PROTECTED_ENDING: lease cleanup (held-input release, tap stop, lock release)
/// must finish within this before the process exits anyway. Exit also drops the tap and flock.
let protectedEndingSafetyMs = 3_000

func helperLifecycleState(leaseActive: Bool, leaseEnding: Bool, msSinceActivity: Int,
                          idleMs: Int) -> HelperLifecycleState {
    if leaseEnding { return .protectedEnding }
    if leaseActive { return .protectedActive }
    if idleMs > 0 && msSinceActivity >= idleMs { return .idle }
    return .backgroundActive
}

/// The generic idle timer may end the process only when nothing protected is in flight.
func helperMayExitOnIdle(_ state: HelperLifecycleState) -> Bool {
    state == .idle
}

enum HostDisconnectAction: Equatable {
    /// No protected state: exit now (the existing connect-mode behavior).
    case exit
    /// Protected: release held input, keep the lease, try to reconnect for at most `graceMs`.
    case reconnectWithinGrace(graceMs: Int)
    /// Already tearing down: finish cleanup (bounded by protectedEndingSafetyMs), then exit.
    case finishEndingThenExit
}

func hostDisconnectAction(_ state: HelperLifecycleState) -> HostDisconnectAction {
    switch state {
    case .protectedActive: return .reconnectWithinGrace(graceMs: protectedReconnectGraceMs)
    case .protectedEnding: return .finishEndingThenExit
    case .idle, .backgroundActive: return .exit
    }
}

/// What a successful reconnect means for a lease held across the gap: the new connection is a new
/// generation, and a native lease never crosses generations. The runtime re-acquires a NEW lease
/// through its still-valid ProtectedForegroundGrant.
let reconnectFencedLeaseCode = "connection_generation_changed"

/// What grace expiry means: the host never came back, so the lease ends and control returns.
let graceExpiredLeaseCode = "host_disconnected"
