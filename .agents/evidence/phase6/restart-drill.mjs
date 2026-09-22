const BASE = "http://localhost:3031", WS = "ws://localhost:3031", ROUTE = "/fork";
const out = [];
const rec = (n, p, d) => { out.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function device() {
  try { const r = await fetch(`${BASE}${ROUTE}/api/device`, { cache: "no-store" });
        return r.ok ? await r.json() : { httpStatus: r.status }; }
  catch (e) { return { unreachable: true, error: e.cause?.code ?? e.message }; }
}
async function ticket(id) {
  try { const r = await fetch(`${BASE}${ROUTE}/api/relay-ticket`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: id }) });
        return r.ok ? { ticket: (await r.json()).ticket } : { status: r.status }; }
  catch (e) { return { unreachable: true, error: e.cause?.code ?? e.message }; }
}
function attempt(id, tk, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}${ROUTE}/relay/ws?deviceId=${encodeURIComponent(id)}&ticket=${encodeURIComponent(tk)}`);
    ws.binaryType = "arraybuffer"; let got = null;
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ outcome: "timeout", ws }); }, timeoutMs);
    ws.addEventListener("message", (e) => { if (got === null) { got = e.data.byteLength; clearTimeout(t);
      resolve({ outcome: "initialized", bytes: got, ws }); } });
    ws.addEventListener("close", (e) => { if (got === null) { clearTimeout(t);
      resolve({ outcome: "closed", code: e.code, ws }); } });
    ws.addEventListener("error", () => {});
  });
}

// Establish a live browser attachment, then restart the Mac under it.
const d0 = await device();
const t0 = await ticket(d0.deviceId);
const live = await attempt(d0.deviceId, t0.ticket);
rec("baseline attachment is live before the restart", live.outcome === "initialized", `bytes=${live.bytes}`);

let closedCode = null, closedAt = null;
live.ws.addEventListener("close", (e) => { closedCode = e.code; closedAt = Date.now(); });

console.log("\n--- killing the isolated Mac process ---");
const killedAt = Date.now();
process.kill(Number(process.env.ISO_PID), "SIGKILL");
await sleep(2500);

rec("live browser socket observes the drop", closedCode !== null,
  closedCode === null ? "socket never closed" : `code=${closedCode} after ${closedAt - killedAt}ms`);
const dDown = await device();
rec("presence probe fails closed while the Mac is down", Boolean(dDown.unreachable || dDown.httpStatus),
  dDown.unreachable ? `unreachable (${dDown.error})` : `http ${dDown.httpStatus}`);
const tDown = await ticket(d0.deviceId);
rec("ticket mint fails closed while the Mac is down (no hang)", Boolean(tDown.unreachable || tDown.status),
  tDown.unreachable ? `unreachable (${tDown.error})` : `http ${tDown.status}`);

console.log("\n--- restarting the isolated Mac ---");
const { spawn } = await import("node:child_process");
const child = spawn(process.env.ISO_RUN, { stdio: "ignore", detached: true, shell: false });
child.unref();

// Poll exactly like the controller's bounded backoff would.
let recovered = null, waited = 0;
for (const delay of [500, 1000, 2000, 4000, 8000, 15000, 15000]) {
  await sleep(delay); waited += delay;
  const d = await device();
  if (d?.online) { const t = await ticket(d.deviceId);
    if (t.ticket) { const a = await attempt(d.deviceId, t.ticket);
      if (a.outcome === "initialized") { recovered = { a, waited, d }; break; } } }
}
rec("automatic recovery reconnects after the Mac returns", Boolean(recovered),
  recovered ? `Initialize bytes=${recovered.a.bytes} after ~${recovered.waited}ms of backoff` : "never recovered");
rec("recovered device keeps a stable identity", recovered?.d.deviceId === d0.deviceId,
  recovered ? `${d0.deviceId} -> ${recovered.d.deviceId}` : "-");
recovered?.a.ws.close();

await sleep(300);
const bad = out.filter((x) => !x).length;
console.log(`\n${out.length - bad}/${out.length} checks passed`);
process.exit(bad ? 1 : 0);
