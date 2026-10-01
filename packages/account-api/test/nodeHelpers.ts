import WebSocket from "ws";
import { deviceAuthMessage } from "../src/deviceChannel.js";
import { claimMessage } from "../src/pairing.js";
import { createTestApp, makeNodeKeys } from "./helpers.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const person = (n: string) => ({
  displayName: n,
  avatarUrl: null,
  verifiedEmails: [`${n}@example.test`],
});
export type Harness = Awaited<ReturnType<typeof setupTasks>>;

const post = (url: string, json: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });

export async function setupTasks(options: Parameters<typeof createTestApp>[0] = {}) {
  const t = await createTestApp({
    users: { u_a: person("a"), u_b: person("b") },
    realClock: true,
    ...options,
  });
  await t.ledger.approve({ clerkUserId: "u_a" });
  await t.ledger.approve({ clerkUserId: "u_b" });
  return { ...t, a: t.as("u_a"), b: t.as("u_b") };
}

/** Pairs a node over real HTTP as `owner` (a or b) and returns its identity. */
export async function pairNode(
  t: Harness,
  base: string,
  options: { owner?: "a" | "b"; capabilities?: string[]; name?: string } = {},
) {
  const keys = makeNodeKeys();
  const human = options.owner === "b" ? t.b : t.a;
  const p = (await (
    await post(`${base}/v1/pairings`, {
      publicKey: keys.publicKey,
      displayName: options.name ?? "Dell Server",
      platform: "linux",
      capabilities: options.capabilities ?? ["shell"],
    })
  ).json()) as any;
  await human(`/v1/pairings/${p.pairingId}/approve`, { method: "POST", json: {} });
  const ch = (await (
    await post(`${base}/v1/pairings/${p.pairingId}/challenge`, { secret: p.secret })
  ).json()) as any;
  const claimed = (await (
    await post(`${base}/v1/pairings/${p.pairingId}/claim`, {
      secret: p.secret,
      nonce: ch.nonce,
      signature: keys.sign(claimMessage(p.pairingId, ch.nonce)),
    })
  ).json()) as any;
  return { keys, deviceId: claimed.deviceId as string };
}

/** A scriptable node: speaks the raw device-channel protocol so tests control every frame. */
export class FakeNode {
  ws!: WebSocket;
  messages: any[] = [];
  closed: { code: number } | null = null;
  constructor(
    readonly url: string,
    readonly deviceId: string,
    readonly keys: ReturnType<typeof makeNodeKeys>,
  ) {}
  static async connect(
    url: string,
    deviceId: string,
    keys: ReturnType<typeof makeNodeKeys>,
    options: { sync?: { taskId: string; attempt: number }[] | false } = {},
  ) {
    const node = new FakeNode(url, deviceId, keys);
    await node.open();
    node.send({ type: "hello", deviceId, protocol: 1 });
    const ch = await node.waitFor((m) => m.type === "challenge");
    node.send({ type: "auth", signature: keys.sign(deviceAuthMessage(deviceId, ch.nonce)) });
    await node.waitFor((m) => m.type === "authenticated");
    if (options.sync !== false) node.send({ type: "task.sync", active: options.sync ?? [] });
    return node;
  }
  open() {
    this.ws = new WebSocket(this.url);
    this.ws.on("message", (d) => this.messages.push(JSON.parse(d.toString())));
    this.ws.on("close", (code) => (this.closed = { code }));
    this.ws.on("error", () => {});
    return new Promise<void>(
      (ok, fail) => (this.ws.once("open", () => ok()), this.ws.once("error", fail)),
    );
  }
  send(frame: Record<string, unknown>) {
    this.ws.send(JSON.stringify(frame));
  }
  async waitFor(pred: (m: any) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error(
      `timeout; saw ${JSON.stringify(this.messages)} closed=${JSON.stringify(this.closed)}`,
    );
  }
  async waitClosed(ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.closed) return this.closed;
      await sleep(10);
    }
    throw new Error("timeout waiting for close");
  }
  offers = () => this.messages.filter((m) => m.type === "task.offer");
  drop() {
    this.ws.terminate();
  }
}

export const proc = (extra: Record<string, unknown> = {}) => ({
  executable: "pnpm",
  args: ["test"],
  cwd: "/projects/lifecraft",
  timeoutMs: 60_000,
  ...extra,
});
export const taskView = async (t: Harness, id: string, who: "a" | "b" = "a") =>
  ((await (await (who === "a" ? t.a : t.b)(`/v1/tasks/${id}`)).json()) as any).task;
export const taskEvents = async (t: Harness, id: string, after = 0) =>
  ((await (await t.a(`/v1/tasks/${id}/events?after=${after}`)).json()) as any).events as any[];
export async function createTask(
  t: Harness,
  deviceId: string,
  extra: Record<string, unknown> = {},
) {
  const r = await t.a("/v1/tasks", {
    method: "POST",
    json: { targetDeviceId: deviceId, process: proc(), ...extra },
  });
  return { status: r.status, body: (await r.json()) as any };
}
export const waitState = async (t: Harness, id: string, state: string, ms = 3000) => {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    last = (await taskView(t, id)).state;
    if (last === state) return;
    await sleep(15);
  }
  throw new Error(`task ${id} stayed ${last}, wanted ${state}`);
};
export const ok = { exitCode: 0, signal: null, durationMs: 5, droppedBytes: 0, timedOut: false };
