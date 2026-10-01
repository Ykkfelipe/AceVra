# AceVra Node pairing, device authentication and presence — M2C

Status: implemented with this change. Extends `acevra-device-registry-m2b.md`. M2C is TRUST +
PRESENCE + TRANSPORT only: no shell, file, git, Computer Use, task routing or sync.

## Components

- **Node** (`packages/node`, bin `acevra`): headless, no Electron. Existing `zcode` server CLI
  is a ZCode release/service manager; pairing there would drag in that machinery, so a small
  dedicated entrypoint was added. Commands: `acevra node connect|status|disconnect`.
- **Control plane** (`packages/account-api`): pairing endpoints, `devices.public_key`/
  `device_key_id`, and an outbound realtime channel `GET /v1/device-channel` (WebSocket).
- **Desktop**: Account → Devices → "Pair a node" (look up by code, review, approve/reject).

## Node identity and storage

`~/.acevra-node/` (override `ACEVRA_NODE_HOME`, mode 0700): `key.pem` (Ed25519 PKCS#8, 0600,
created exclusively, tightened if loosened), `node.json` (0600: control-plane URL, display name,
device id, key id, short-lived pairing secret until claimed), `status.json`, `logs/node.log`.
The private key is generated on the device and never uploaded, returned, logged or printed.
Identity is not derived from hostname/MAC/serial/hardware. Keystore-backed private-key storage
is future work; the file model is the M2C trust level (0600, owner-only).

## Pairing flow

```
Node: POST /v1/pairings {publicKey(Ed25519 SPKI), displayName, platform, capabilities}
  → {pairingId, secret(256-bit, shown once), code "ABCD-EFGH" (8 chars, no 0/O/1/I/L), expiresAt (10 min)}
Human (Clerk, admitted): POST /v1/pairings/lookup {code}  → preview {name, platform, capabilities}
  (the code is the ONLY discovery path; no global pending list is exposed)
Human: POST /v1/pairings/:id/approve|reject   → the approving account becomes the owner
Node: POST /v1/pairings/:id/status {secret}   (poll)
Node: POST /v1/pairings/:id/challenge {secret} → one-time nonce (60 s)   [approved only]
Node: POST /v1/pairings/:id/claim {secret, nonce, signature over
      "acevra-pair-claim:v1:<pairingId>:<nonce>"}  → creates devices row (type=node,
      device_key_id, public_key) and returns {deviceId, keyId}
```

Server stores only SHA-256 of the secret and the code. Single use: a claimed/rejected/expired
pairing is dead; the nonce is consumed on every attempt; 5 bad proofs burn the pairing. Lookup
misses are limited per account (5 per 10 min); unauthenticated creation is limited per client.
Approval alone is not a credential: the claim requires proof of private-key possession.
A pairing approved by one account can only produce a device owned by that account; another
account can neither re-decide nor claim it. Re-pairing a revoked node is a brand-new pairing and
a new device row — the old credential is never resurrected.

## Device authentication and session (no bearer token on disk)

Realtime channel, JSON text frames, max 4 KiB, no CORS/Origin (browser upgrades refused):

- Client → server: `hello{deviceId,protocol:1}`, `auth{signature}`, `heartbeat`, `pong`,
  `capabilities{capabilities[]}`, `reauth`.
- Server → client: `challenge{nonce}`, `authenticated{sessionExpiresAt,pingIntervalMs}`, `ping`,
  `pong`, `session_expiring`, `revoked`, `disconnect{reason}`, `error{code}`.

`auth` = Ed25519 signature over `acevra-device-auth:v1:<deviceId>:<nonce>`. A challenge is issued
even for unknown ids; only the key holder learns a device is revoked. Admission requires: device
exists as a node with a key, key proof valid, `revoked_at IS NULL`, and the owning human still
admitted. The session lives `sessionTtl` (default 10 min); `session_expiring` is sent before
expiry and the node renews in-band with `reauth` (re-proves the key). No Clerk token ever
reaches a node. Unknown message types (including any command-like type) close the connection;
oversize/binary/malformed/unauthenticated/flooding are refused (rate limit per connection).
One live session per device (a newer connection replaces the older). Plain `ws://` is accepted
by the node only for loopback or `ACEVRA_NODE_ALLOW_INSECURE=1`; production is `wss://`.

## Presence and revocation

online = live authenticated channel, or last check-in within the grace window (nodes: bounded by
`nodeGraceMs`); offline beyond it; revoked overrides. The HTTP heartbeat is desktop-only (a human
session cannot forge node presence). Pings every 20 s re-read revocation/admission, so even a
multi-instance deployment drops a revoked device within one interval; the instance holding the
socket closes it immediately on revoke (`revoked`, close 4001). A revoked node exits terminal and
stays local-capable. Revoked devices can never re-authenticate.

## Capabilities (truthful)

Derived from wired services, descriptive only. Desktop: files and shell (Host registers
IFileService/ITerminalService), git (IGitService + a `git` binary probe), computerUse (supported
OS). Node: none — no execution service is wired in M2C, and an installed binary is not a wired
service. Providers register in `packages/node/src/capabilities.ts` as they land.

## Reconnect

The node dials out with jittered exponential backoff, re-proving the same identity; same device
row, no re-pairing, no Clerk. Backend restarts and network drops are covered by tests.

## Acceptance

Backend (pairing, channel, registry), node (CLI, identity, transport, reconnect, restart,
revoke), and E2E (real desktop + backend + spawned headless node): see the test suites.
