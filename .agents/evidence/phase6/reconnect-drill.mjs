
const BASE = "http://localhost:3031";
const WS = "ws://localhost:3031";
const ROUTE = "/fork";
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function device() {
  const r = await fetch(`${BASE}${ROUTE}/api/device`, { cache: "no-store" });
  return r.ok ? await r.json() : undefined;
}
async function mintRelayTicket(deviceId) {
  const r = await fetch(`${BASE}${ROUTE}/api/relay-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (!r.ok) return { status: r.status };
  return { status: r.status, ticket: (await r.json()).ticket };
}
/** Mimic one attempt of the reconnect controller: fresh ticket -> fresh attachment. */
function attempt(deviceId, ticket, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const url = `${WS}${ROUTE}/relay/ws?deviceId=${encodeURIComponent(deviceId)}&ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(url);
    let firstInbound = null;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ outcome: "timeout", ws });
    }, timeoutMs);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e) => {
      if (firstInbound === null) {
        firstInbound = e.data?.byteLength ?? e.data?.length ?? 0;
        clearTimeout(timer);
        resolve({ outcome: "initialized", firstInboundBytes: firstInbound, ws });
      }
    });
    ws.addEventListener("close", (e) => {
      if (firstInbound === null) {
        clearTimeout(timer);
        resolve({ outcome: "closed", code: e.code, reason: e.reason ?? "", ws });
      }
    });
    ws.addEventListener("error", () => {});
  });
}

const d = await device();
record("device presence reports the isolated Mac online", Boolean(d?.online),
  d ? `${d.displayName} ${d.deviceId}` : "no device");

// 1. First connection (cold start).
const t1 = await mintRelayTicket(d.deviceId);
const a1 = await attempt(d.deviceId, t1.ticket);
record("gen 1: fresh ticket opens an attachment and receives Initialize",
  a1.outcome === "initialized", `${a1.outcome} bytes=${a1.firstInboundBytes ?? "-"}`);

// 2. Replaying a consumed ticket must be refused without pairing.
const a2 = await attempt(d.deviceId, t1.ticket, { timeoutMs: 6000 });
record("replayed ticket is refused with 4001",
  a2.outcome === "closed" && a2.code === 4001, `${a2.outcome} code=${a2.code ?? "-"}`);

// 3. Simulate the socket dropping, then reconnect exactly as the controller does.
a1.ws.close();
await new Promise((r) => setTimeout(r, 800));
const t2 = await mintRelayTicket(d.deviceId);
record("reconnect mints a NEW single-use ticket", Boolean(t2.ticket) && t2.ticket !== t1.ticket,
  t2.ticket === t1.ticket ? "ticket was reused!" : "distinct ticket");
const a3 = await attempt(d.deviceId, t2.ticket);
record("gen 2: reconnect gets a fresh attachment and a fresh Initialize",
  a3.outcome === "initialized", `${a3.outcome} bytes=${a3.firstInboundBytes ?? "-"}`);

// 4. A second browser may hold its own attachment concurrently.
const t3 = await mintRelayTicket(d.deviceId);
const a4 = await attempt(d.deviceId, t3.ticket);
record("gen 3: a concurrent second browser gets its own attachment",
  a4.outcome === "initialized", `${a4.outcome} bytes=${a4.firstInboundBytes ?? "-"}`);
record("concurrent attachments are isolated (first still open)",
  a3.ws.readyState === WebSocket.OPEN, `gen2 readyState=${a3.ws.readyState}`);

// 5. Unknown device is a 404, not a hang.
const bad = await mintRelayTicket("0000000000000000");
record("relay-ticket for an unknown device is 404", bad.status === 404, `status=${bad.status}`);

a3.ws.close(); a4.ws.close();
await new Promise((r) => setTimeout(r, 300));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
