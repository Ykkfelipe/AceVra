import {
  type ComputerAction,
  type ComputerCommandResult,
  type ComputerImage,
  type ComputerInputEvent,
  type ComputerTestResult,
  type ComputerView,
  type ExecutionTarget,
  type SshComputerConfig,
} from "@zcode/shared";
import {
  HEARTBEAT_MS,
  PANEL_CONTROLLER,
  SESSION_CONTROLLER_PREFIX,
  SESSION_IDLE_MS,
  computerIdOf,
  deriveControl,
  isActiveJob,
  targetIdFor,
  toJobView,
} from "./computerJob.js";
import {
  classifyActionFailure,
  runInputAction,
  type ComputerActionOutcome,
} from "./computerActions.js";
import { fetchWorkerToken, type SpawnFn } from "./sshCommand.js";
import { createSshTunnel, type SshTunnel, type TunnelState } from "./sshTunnel.js";
import type { OpenViewSocket } from "./computerViewStream.js";
import { testComputer } from "./computerHealth.js";
import { createViewRelay, type FrameSink, type ViewRelay } from "./computerViewRelay.js";
import type { SshComputersStore } from "./sshComputersStore.js";
import { createWorkerClient, type WorkerClient, type WorkerResponse } from "./workerClient.js";
import { createServiceLogger } from "@zcode/services/node";

const log = createServiceLogger("computers");

interface Entry {
  config: SshComputerConfig;
  tunnel: SshTunnel;
  token: string | null;
  client: WorkerClient | null;
  offlineReason: string | null;
  job: Record<string, any> | null;
  /** Correlation only: which conversation's agent lease this computer's external job is. */
  session: { sessionId: string; jobId: string; lastActionAt: number } | null;
  announcedSessions: Set<string>;
  lastAction: string | null;
  screen: { width: number; height: number } | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  view: ViewRelay;
}

/**
 * SSH computers runtime in Main (process infrastructure only). The worker is the single authority
 * for job / lease / pause / take-control / yield; this service only correlates a conversation to
 * the worker job it attached and relays frames/input for visible Computer tabs.
 */
export function createComputersService(deps: {
  store: SshComputersStore;
  spawn: SpawnFn;
  fetch: typeof fetch;
  openSocket: OpenViewSocket;
  /** PNG → model image (Electron nativeImage JPEG in production). */
  encodeScreenshot: (png: Buffer) => ComputerImage | null;
  onView: (view: ComputerView) => void;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}) {
  const entries = new Map<string, Entry>();

  async function entryFor(computerId: string): Promise<Entry | null> {
    const existing = entries.get(computerId);
    const config = await deps.store.get(computerId);
    if (!config) {
      if (existing) dropEntry(existing);
      return null;
    }
    if (existing) {
      existing.config = config;
      return existing;
    }
    const entry: Entry = {
      config,
      token: null,
      client: null,
      offlineReason: null,
      job: null,
      session: null,
      announcedSessions: new Set(),
      lastAction: null,
      screen: null,
      heartbeat: null,
      view: createViewRelay(
        {
          connect: () => connect(entry),
          isHumanControl: () => deriveControl(entry.job) === "human",
          applyJob: (job) => applyJob(entry, job),
          refreshJob: () => refreshJob(entry),
          onScreen: (screen) => {
            entry.screen = screen;
          },
        },
        deps.openSocket,
      ),
      tunnel: createSshTunnel({
        hostAlias: config.hostAlias,
        workerPort: config.workerPort,
        spawn: deps.spawn,
        fetch: deps.fetch,
        onState: (state) => onTunnelState(entry, state),
      }),
    };
    entries.set(computerId, entry);
    return entry;
  }

  function onTunnelState(entry: Entry, state: TunnelState) {
    if (state.kind === "offline") {
      entry.offlineReason = state.reason;
      entry.client = null;
      entry.view.closeStream();
    }
    if (state.kind === "online") {
      entry.offlineReason = null;
      // 隧道退避重连成功后，仍有可见 Computer tab 时重新打开画面流（否则离线一次就永远黑屏）。
      entry.view.reopen();
    }
    emit(entry);
  }

  function viewOf(entry: Entry): ComputerView {
    const tunnel = entry.tunnel.state();
    const connection =
      tunnel.kind === "online" && entry.client
        ? "online"
        : tunnel.kind === "connecting" || (tunnel.kind === "online" && !entry.offlineReason)
          ? "connecting"
          : "offline";
    return {
      computerId: entry.config.id,
      name: entry.config.name,
      connection,
      offlineReason: connection === "offline" ? (entry.offlineReason ?? "not_connected") : null,
      job: toJobView(entry.job),
      control: deriveControl(entry.job),
      panelOwnsJob: isActiveJob(entry.job) && entry.job.controller === PANEL_CONTROLLER,
      lastAction: entry.lastAction,
      screen: entry.screen,
    };
  }

  const emit = (entry: Entry) => deps.onView(viewOf(entry));

  /** Tunnel + token (memory only). Never falls back to anything local. */
  async function connect(entry: Entry): Promise<WorkerClient | null> {
    const state = await entry.tunnel.ensure();
    if (state.kind !== "online") {
      entry.offlineReason = state.kind === "offline" ? state.reason : "not_connected";
      emit(entry);
      return null;
    }
    if (entry.client && entry.client.port === state.port) return entry.client;
    if (!entry.token) entry.token = await fetchWorkerToken(deps.spawn, entry.config.hostAlias);
    if (!entry.token) {
      entry.offlineReason = "token_unavailable";
      emit(entry);
      return null;
    }
    entry.client = createWorkerClient({ port: state.port, token: entry.token, fetch: deps.fetch });
    entry.offlineReason = null;
    await refreshJob(entry);
    return entry.client;
  }

  /** 401 → the token rotated on the worker: refetch once. */
  async function call(
    entry: Entry,
    run: (client: WorkerClient) => Promise<WorkerResponse>,
  ): Promise<WorkerResponse> {
    let client = await connect(entry);
    if (!client)
      return { ok: false, status: 0, code: "offline", reason: entry.offlineReason, json: null };
    let result = await run(client);
    if (!result.ok && result.status === 401) {
      entry.token = null;
      entry.client = null;
      client = await connect(entry);
      if (!client) return result;
      result = await run(client);
    }
    return result;
  }

  async function refreshJob(entry: Entry) {
    if (!entry.client) return;
    const result = await entry.client.get("/agent/job");
    if (result.ok) applyJob(entry, result.json);
  }

  function applyJob(entry: Entry, job: Record<string, any> | null) {
    entry.job = isActiveJob(job) ? job : null;
    if (entry.session && entry.job?.job_id !== entry.session.jobId) stopSessionLease(entry);
    entry.view.refreshProfile();
    emit(entry);
  }

  function stopSessionLease(entry: Entry) {
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    entry.heartbeat = null;
    entry.session = null;
  }

  function startHeartbeat(entry: Entry) {
    if (entry.heartbeat) return;
    entry.heartbeat = setInterval(() => {
      const session = entry.session;
      if (!session || !entry.client) return stopSessionLease(entry);
      // 空闲 10 分钟停止续约，lease 在 worker 侧自然过期（不由 Mac 判定任务结束）。
      if (Date.now() - session.lastActionAt > SESSION_IDLE_MS) return stopSessionLease(entry);
      void entry.client.post("/agent/heartbeat", { job_id: session.jobId });
    }, HEARTBEAT_MS);
  }

  /** The conversation's lease: reuse its job, attach a new external job, or refuse (busy). */
  async function ensureSessionJob(
    entry: Entry,
    sessionId: string,
  ): Promise<{ ok: true; jobId: string; started?: boolean } | ComputerActionOutcome> {
    await refreshJob(entry);
    const job = entry.job;
    if (isActiveJob(job)) {
      if (entry.session?.sessionId === sessionId && job.job_id === entry.session.jobId)
        return { ok: true, jobId: entry.session.jobId };
      if (job.controller === PANEL_CONTROLLER)
        return { ok: false, reason: "computer_busy", detail: "user_in_control" };
      return { ok: false, reason: "computer_busy", detail: "another_job_active" };
    }
    const attached = await call(entry, (client) =>
      client.post("/agent/attach", {
        task: "AceVra conversation",
        controller: `${SESSION_CONTROLLER_PREFIX}${sessionId}`,
      }),
    );
    if (!attached.ok) {
      return attached.code === "offline"
        ? { ok: false, reason: "computer_offline", detail: attached.reason ?? undefined }
        : { ok: false, reason: "computer_busy", detail: attached.reason ?? "attach_refused" };
    }
    const attachedJob = (attached.json.job ?? attached.json) as Record<string, any>;
    const jobId = String(attachedJob.job_id ?? "");
    if (!jobId) return { ok: false, reason: "internal", detail: "attach_without_job" };
    entry.session = { sessionId, jobId, lastActionAt: Date.now() };
    applyJob(entry, attachedJob);
    startHeartbeat(entry);
    const started = !entry.announcedSessions.has(sessionId);
    entry.announcedSessions.add(sessionId);
    return { ok: true, jobId, started };
  }

  async function runAction(
    entry: Entry,
    jobId: string,
    action: ComputerAction,
  ): Promise<WorkerResponse | { ok: true; image: ComputerImage | null }> {
    if (action.kind === "screenshot") {
      const client = await connect(entry);
      const shot = client ? await client.screenPng() : null;
      if (!shot)
        return { ok: false, status: 0, code: "offline", reason: "screen_unavailable", json: null };
      // action→fresh-frame 延迟测量（spec 4.5.1）：worker 已保证画面收敛后再返回。
      log.debug(
        `screen settle=${shot.settleMs ?? "?"}ms converged=${shot.converged ?? "?"} ` +
          `${shot.png.length}B`,
      );
      if (shot.converged === false)
        log.warn(`screen did not converge within the worker settle window`);
      return { ok: true, image: deps.encodeScreenshot(shot.png) };
    }
    return runInputAction(action, (path, body) =>
      call(entry, (client) => client.post(path, { job_id: jobId, ...body }, "agent")),
    );
  }

  async function computerAction(input: {
    sessionId: string;
    targetId: string;
    action: ComputerAction;
  }): Promise<ComputerActionOutcome> {
    const computerId = computerIdOf(input.targetId);
    const entry = computerId ? await entryFor(computerId) : null;
    if (!entry) return { ok: false, reason: "target_not_found" };
    if (!(await connect(entry)))
      return { ok: false, reason: "computer_offline", detail: entry.offlineReason ?? undefined };
    let lease = await ensureSessionJob(entry, input.sessionId);
    if (!lease.ok) return lease as ComputerActionOutcome;
    const sessionStarted = "started" in lease && lease.started === true;
    let result = await runAction(entry, (lease as { jobId: string }).jobId, input.action);
    if (!result.ok && (result.reason === "stale_job_id" || result.reason === "no_active_job")) {
      // lease 已在 worker 侧过期：重新 attach 一次再执行，不在 Mac 侧猜测任务状态。
      stopSessionLease(entry);
      lease = await ensureSessionJob(entry, input.sessionId);
      if (!lease.ok) return lease as ComputerActionOutcome;
      result = await runAction(entry, (lease as { jobId: string }).jobId, input.action);
    }
    if (entry.session) entry.session.lastActionAt = Date.now();
    entry.lastAction = input.action.kind;
    if (!result.ok) {
      await refreshJob(entry);
      return classifyActionFailure(result);
    }
    const image = "image" in result ? result.image : null;
    if (image) entry.screen = { width: image.width, height: image.height };
    emit(entry);
    return {
      ok: true,
      screen: entry.screen ?? { width: 0, height: 0 },
      ...(image ? { image } : {}),
      ...(sessionStarted ? { sessionStarted } : {}),
    };
  }

  function dropEntry(entry: Entry) {
    stopSessionLease(entry);
    entry.view.close();
    entry.tunnel.release();
    entries.delete(entry.config.id);
  }

  async function command(
    computerId: string,
    run: (entry: Entry) => Promise<ComputerCommandResult>,
  ): Promise<ComputerCommandResult> {
    const entry = await entryFor(computerId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (!(await connect(entry))) return { ok: false, reason: entry.offlineReason ?? "offline" };
    const result = await run(entry);
    await refreshJob(entry);
    return result;
  }

  const toCommand = (result: WorkerResponse): ComputerCommandResult =>
    result.ok
      ? { ok: true }
      : { ok: false, reason: result.reason ?? result.code ?? `status_${result.status}` };

  return {
    async listTargets(): Promise<ExecutionTarget[]> {
      return (await deps.store.list()).map((config) => {
        const entry = entries.get(config.id);
        // 未尝试连接前视为在线（可用）；只有真实连接失败才报告离线。
        const offline = entry
          ? viewOf(entry).connection === "offline" && entry.offlineReason !== null
          : false;
        return {
          id: targetIdFor(config.id),
          type: "ssh" as const,
          displayName: config.name,
          online: !offline,
          capabilities: ["computerUse", "shell"],
          isThisDevice: false,
          available: true,
        };
      });
    },
    async hostAliasFor(targetId: string): Promise<string | null> {
      const computerId = computerIdOf(targetId);
      return computerId ? ((await deps.store.get(computerId))?.hostAlias ?? null) : null;
    },
    computerAction,
    async getView(computerId: string): Promise<ComputerView | null> {
      const entry = await entryFor(computerId);
      if (!entry) return null;
      void connect(entry);
      return viewOf(entry);
    },
    test: (input: { hostAlias: string; workerPort: number }): Promise<ComputerTestResult> =>
      testComputer({ spawn: deps.spawn, fetch: deps.fetch }, input),
    subscribe(computerId: string, sink: FrameSink): () => void {
      let disposed = false;
      void entryFor(computerId).then((entry) => {
        if (!entry || disposed) return;
        entry.view.add(sink);
      });
      return () => {
        disposed = true;
        const entry = entries.get(computerId);
        if (!entry) return;
        entry.view.remove(sink);
      };
    },
    sendInput(computerId: string, events: ComputerInputEvent[]) {
      const entry = entries.get(computerId);
      const jobId = entry?.job?.job_id;
      // 只有用户已接管（worker human_control）时才转发；worker 侧仍会再次校验 human gate。
      if (!entry || !jobId || deriveControl(entry.job) !== "human") return;
      entry.view.sendInput(String(jobId), events);
    },
    takeControl: (computerId: string) =>
      command(computerId, async (entry) => {
        await refreshJob(entry);
        if (!isActiveJob(entry.job)) {
          const attached = await call(entry, (client) =>
            client.post("/agent/attach", {
              task: "Manual control from AceVra",
              controller: PANEL_CONTROLLER,
            }),
          );
          if (!attached.ok) return toCommand(attached);
        }
        return toCommand(
          await call(entry, (client) => client.post("/agent/take-control", {}, undefined, 50_000)),
        );
      }),
    giveBack: (computerId: string) =>
      command(computerId, async (entry) => {
        const jobId = entry.job?.job_id;
        if (jobId) entry.view.sendInput(String(jobId), [{ kind: "release" }]);
        const panelOwned = isActiveJob(entry.job) && entry.job.controller === PANEL_CONTROLLER;
        return toCommand(
          await call(entry, (client) => client.post(panelOwned ? "/agent/stop" : "/agent/resume")),
        );
      }),
    resume: (computerId: string) =>
      command(computerId, async (entry) =>
        toCommand(await call(entry, (client) => client.post("/agent/resume"))),
      ),
    stop: (computerId: string) =>
      command(computerId, async (entry) => {
        const result = toCommand(await call(entry, (client) => client.post("/agent/stop")));
        stopSessionLease(entry);
        return result;
      }),
    async forget(computerId: string) {
      const entry = entries.get(computerId);
      if (entry) dropEntry(entry);
    },
    dispose() {
      for (const entry of entries.values()) dropEntry(entry);
    },
  };
}
export type ComputersService = ReturnType<typeof createComputersService>;
