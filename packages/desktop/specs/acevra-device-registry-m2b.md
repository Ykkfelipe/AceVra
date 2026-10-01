# AceVra device registry — M2B

Status: implemented with this change. Builds on `acevra-account.md` and `acevra-account-m2a.md`.
Scope: Device metadata, local installation identity, human-session-backed registration and
HTTP heartbeat presence. No pairing, device credential, WSS, sync, routing or cloud device.

## Model

`devices(id, account_id → accounts, installation_id UNIQUE, type desktop|node, platform,
display_name, capabilities text[], device_key_id NULL, created_at, last_seen_at, revoked_at,
UNIQUE(account_id,id))`. API views never expose `installation_id`, `device_key_id` or
`account_id`. `cloud` is not a valid type yet.

- **Installation identity:** random UUID in `<userData>/acevra-installation.json`; not derived
  from hardware, serial, MAC or hostname; non-secret lookup key, never a credential. Survives
  sign-out. The backend assigns the canonical `devices.id`.
- **Binding policy:** one installation ↔ one account. A different account registering the same
  installation gets `409 installation_bound`; no automatic transfer (private-alpha decision).
  Re-registering the same installation is idempotent (same device; user-chosen name kept;
  platform/capabilities/lastSeen refreshed). A revoked device cannot be resurrected (`403
device_revoked`).
- **Capabilities:** closed descriptive set `computerUse|shell|files|git|longTasks|minecraft`.
  They are facts the device reports, never permission grants or authorization input. The desktop
  advertises only what is wired: files, shell, git, plus computerUse when the OS supports it.
- **Presence:** `online` if `last_seen_at` within 90 s, else `offline`; `revoked` overrides. The
  desktop POSTs a heartbeat every 30 s while the account is `ready`. No WSS; nothing is permanent.
- **Ownership:** every query is scoped by the server-resolved account id. Another account's
  device id behaves as nonexistent (404). Admission is re-checked on every device call.

## Endpoints (all Clerk bearer + admitted)

`GET /v1/devices` · `POST /v1/devices/register` (201 new, 200 existing, 400, 409, 403) ·
`PATCH /v1/devices/:id` (rename) · `POST /v1/devices/:id/heartbeat` (403 `device_revoked`) ·
`POST /v1/devices/:id/revoke`.

## Desktop behavior

Main owns registration (`accountDevices.ts`), triggered on the account entering `ready` and
stopped when it leaves. Sign-out stops heartbeats only: it never unregisters, never deletes the
installation id, and local tools/providers/conversations are unaffected. Local-only mode never
touches the registry. The UI lists only real registered devices, labels this one, allows rename
and revoke.

## Credential boundary

M2B registration is human-session-backed with no device secret. Node authentication is
specified and implemented in `acevra-node-pairing-m2c.md`.

## Acceptance

Backend: register/list/rename/heartbeat/revoke, cross-account isolation, duplicate/concurrent
registration, installation takeover refused, capability tampering, forged ids, revoked behavior,
admission re-check. Desktop: registration payload, logout/relogin semantics, conflict, revoked,
late-result fencing, installation identity stability. E2E (isolated profile, deterministic
admitted token): register → UI shows this device → rename → sign-out/in same device →
relaunch same device → other account refused → revoke → local inference still works.
