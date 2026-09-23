/**
 * Task artifacts（phase 11）— 注册、授权边界与检索的 fixture 回归（零推理、零真实进程）。
 *
 * 覆盖 phase 验收清单：
 * - register PNG → inline image artifact；register 任意文件 → 下载卡
 * - 未注册 artifactId 不可取回；../ 穿越（taskId/artifactId）失败
 * - 其他任务（跨 workspaceKey）的 artifact 不可访问
 * - 背后文件被删除 → 状态 missing / 结构化 fault，绝不泄漏路径
 * - 描述符与错误不含宿主绝对路径
 * - 清单幂等（重连不重复）
 * - 同 sha256+origin+turnId 的重复注册返回既有条目（不重复产生卡片）
 * - browser-use 截图结果插桩：成功注册；失败不宣称交付
 * - Codex 用户点名交付：点名的文件注册，未点名的编辑不注册
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/taskArtifacts.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TASK_ARTIFACT_MAX_BYTES,
  isAllowedTaskArtifactMimeType,
  isInlinePreviewMimeType,
  taskArtifactMimeForFileName,
  type TaskArtifactDescriptor,
} from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import {
  instrumentBrowserExecutorForArtifacts,
  TaskArtifactRegistry,
  TaskArtifactRegistrationError,
  TaskArtifactRetrievalError,
} from "../src/task-artifacts/contract.js";
import { selectUserNamedDeliverables } from "../src/codex/domain/codexDelivery.js";
import { CODEX_METHODS } from "../src/codex/domain/codexWire.js";
import { createCodexExecutionService } from "../src/codex/app/codexExecutionServiceImpl.js";
import { DEFAULT_CODEX_EXECUTION_POLICY } from "../src/codex/domain/codexPolicy.js";
import type { CodexAppServerPort, CodexTaskIndexPort } from "../src/codex/app/codexPorts.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

/** 1x1 红色 PNG 的最小头部字节（不需要真实解码，只验证字节保真）。 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const WORKSPACE_A = "/tmp/artifacts-workspace-a";
const WORKSPACE_B = "/tmp/artifacts-workspace-b";
const TASK_ID = "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b";
const TASK_ID_2 = "0a1b2c3d-4e5f-4a1b-8c9d-2e3f4a5b6c7d";

async function makeRegistry(): Promise<{ registry: TaskArtifactRegistry; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "task-artifacts-"));
  setDataBaseDir(dir);
  const registry = new TaskArtifactRegistry({ rootDir: path.join(dir, "store") });
  return { registry, dir };
}

test("register PNG bytes → available image artifact; listing is idempotent", async () => {
  const { registry, dir } = await makeRegistry();
  try {
    const first = await registry.registerTaskArtifact({
      taskId: TASK_ID,
      scope: { workspacePath: WORKSPACE_A },
      origin: "browser-use",
      fileName: "nike_fullpage.png",
      mimeType: "image/png",
      bytes: PNG_BYTES,
      turnId: "turn-1",
    });
    assert.equal(first.artifact.state, "available");
    assert.equal(first.artifact.byteSize, PNG_BYTES.byteLength);
    assert.ok(isInlinePreviewMimeType(first.artifact.mimeType));

    // 幂等：同样的 sha256+origin+turnId 再注册返回既有条目，清单不重复（重连不重复）。
    const again = await registry.registerTaskArtifact({
      taskId: TASK_ID,
      scope: { workspacePath: WORKSPACE_A },
      origin: "browser-use",
      fileName: "nike_fullpage.png",
      mimeType: "image/png",
      bytes: PNG_BYTES,
      turnId: "turn-1",
    });
    assert.equal(again.artifact.artifactId, first.artifact.artifactId);

    const list = await registry.listTaskArtifacts({
      taskId: TASK_ID,
      workspacePath: WORKSPACE_A,
    });
    assert.equal(list.artifacts.length, 1);
    // 描述符不含宿主绝对路径。
    assert.ok(!JSON.stringify(list).includes(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent browser replay registrations share one artifact", async () => {
  const { registry, dir } = await makeRegistry();
  try {
    const registrations = await Promise.all(
      Array.from({ length: 8 }, () =>
        registry.registerTaskArtifact({
          taskId: TASK_ID,
          scope: { workspacePath: WORKSPACE_A },
          origin: "browser-use",
          fileName: "nike.png",
          mimeType: "image/png",
          bytes: PNG_BYTES,
          turnId: "turn-replay",
        }),
      ),
    );
    assert.equal(new Set(registrations.map(({ artifact }) => artifact.artifactId)).size, 1);
    const list = await registry.listTaskArtifacts({ taskId: TASK_ID, workspacePath: WORKSPACE_A });
    assert.equal(list.artifacts.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("register arbitrary file (from hostPath) → downloadable card descriptor; MIME allowlist enforced", async () => {
  const { registry, dir } = await makeRegistry();
  try {
    const source = path.join(dir, "report.pdf");
    await writeFile(source, Buffer.from("%PDF-1.4 fake"));
    const registered = await registry.registerTaskArtifact({
      taskId: TASK_ID,
      scope: { workspacePath: WORKSPACE_A },
      origin: "tool",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      hostPath: source,
    });
    assert.equal(registered.artifact.byteSize, 13);
    // 原始路径不进入描述符。
    assert.ok(!JSON.stringify(registered).includes(dir));

    // 不在 allowlist 的 MIME 注册被拒（fail closed）。
    await assert.rejects(
      registry.registerTaskArtifact({
        taskId: TASK_ID,
        scope: { workspacePath: WORKSPACE_A },
        origin: "tool",
        fileName: "evil.exe",
        mimeType: "application/x-msdownload",
        bytes: new Uint8Array([1]),
      }),
      (error: TaskArtifactRegistrationError) => error.reasonCode === "artifact_mime_not_allowed",
    );
    assert.ok(isAllowedTaskArtifactMimeType("image/png"));
    assert.ok(!isAllowedTaskArtifactMimeType("application/x-msdownload"));
    assert.equal(taskArtifactMimeForFileName("photo.PNG"), "image/png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unregistered artifact ids and traversal shapes cannot be fetched", async () => {
  const { registry } = await makeRegistry();
  const scope = { workspacePath: WORKSPACE_A };

  // 未注册但形状合法的 UUID。
  await assert.rejects(
    registry.readTaskArtifact({
      taskId: TASK_ID,
      artifactId: "11111111-2222-4333-8444-555555555555",
      offset: 0,
      ...scope,
    }),
    (error: TaskArtifactRetrievalError) => error.code === "artifact_not_registered",
  );
  // ../ 穿越（非法形状）在形状检查即被拒绝，绝不触达文件系统。
  await assert.rejects(
    registry.readTaskArtifact({
      taskId: TASK_ID,
      // @ts-expect-error 故意非法形状
      artifactId: "../../etc/passwd",
      offset: 0,
      ...scope,
    }),
    (error: TaskArtifactRetrievalError) => error.code === "artifact_not_registered",
  );
  await assert.rejects(
    registry.readTaskArtifact({
      // @ts-expect-error 故意非法形状
      taskId: "../../home",
      artifactId: TASK_ID,
      offset: 0,
      ...scope,
    }),
    (error: TaskArtifactRetrievalError) => error.code === "artifact_not_registered",
  );
});

test("artifact from another workspace/task scope is not accessible; deleted backing file fails cleanly", async () => {
  const { registry } = await makeRegistry();
  const registered = await registry.registerTaskArtifact({
    taskId: TASK_ID,
    scope: { workspacePath: WORKSPACE_A },
    origin: "browser-use",
    fileName: "shot.png",
    mimeType: "image/png",
    bytes: PNG_BYTES,
  });
  // 其他 workspace 的同任务清单看不到、读取也拿不到。
  const otherScope = await registry.listTaskArtifacts({
    taskId: TASK_ID,
    workspacePath: WORKSPACE_B,
  });
  assert.equal(otherScope.artifacts.length, 0);
  await assert.rejects(
    registry.readTaskArtifact({
      taskId: TASK_ID,
      artifactId: registered.artifact.artifactId,
      offset: 0,
      workspacePath: WORKSPACE_B,
    }),
    (error: TaskArtifactRetrievalError) => error.code === "artifact_not_registered",
  );
  // 第二个任务的注册不会串到第一个任务。
  const otherTask = await registry.listTaskArtifacts({
    taskId: TASK_ID_2,
    workspacePath: WORKSPACE_A,
  });
  assert.equal(otherTask.artifacts.length, 0);

  // 背后文件删除：清单降级 missing、读取结构化 fault，均不含路径。
  await unlink(path.join(registry.rootDir, TASK_ID, `${registered.artifact.artifactId}.bin`));
  const afterDelete = await registry.listTaskArtifacts({
    taskId: TASK_ID,
    workspacePath: WORKSPACE_A,
  });
  assert.equal(afterDelete.artifacts[0]?.state, "missing");
  await assert.rejects(
    registry.readTaskArtifact({
      taskId: TASK_ID,
      artifactId: registered.artifact.artifactId,
      offset: 0,
      workspacePath: WORKSPACE_A,
    }),
    (error: TaskArtifactRetrievalError) => error.code === "artifact_backing_missing",
  );
});

test("browser-use screenshot result is registered structurally; failures never claim delivery", async () => {
  const { registry } = await makeRegistry();
  const baseExecutor = {
    async execute(_input: { sessionId: string; turnId?: string; workspacePath: string }) {
      return {
        ok: true,
        image: { base64: Buffer.from(PNG_BYTES).toString("base64"), mimeType: "image/png" },
      };
    },
  };
  const instrumented = instrumentBrowserExecutorForArtifacts({
    executor: baseExecutor as never,
    registry,
  });
  await instrumented.execute({
    sessionId: TASK_ID,
    turnId: "turn-9",
    workspacePath: WORKSPACE_A,
  } as never);
  const list = await registry.listTaskArtifacts({ taskId: TASK_ID, workspacePath: WORKSPACE_A });
  assert.equal(list.artifacts.length, 1);
  assert.equal(list.artifacts[0]?.origin, "browser-use");

  // 注册失败（MIME 不在 allowlist 等）不影响工具结果，也不产生任何 artifact。
  const failingExecutor = {
    async execute() {
      return { ok: true, image: { base64: "AAAA", mimeType: "image/psd" } };
    },
  };
  const failingInstrumented = instrumentBrowserExecutorForArtifacts({
    executor: failingExecutor as never,
    registry,
  });
  const result = await failingInstrumented.execute({
    sessionId: TASK_ID,
    workspacePath: WORKSPACE_A,
  } as never);
  assert.equal(result.ok, true);
  assert.deepEqual(result.artifactDelivery, { status: "registration_failed" });
  const unchanged = await registry.listTaskArtifacts({
    taskId: TASK_ID,
    workspacePath: WORKSPACE_A,
  });
  assert.equal(unchanged.artifacts.length, 1);
});

test("browser-use instrumentation preserves the full executor interface (list delegates, execute instrumented)", async () => {
  // 回归：旧包装器只返回 execute，host 的 interaction/browserList 调 list 时同步抛错并拖垮 agent 连接。
  const { registry } = await makeRegistry();
  const listCalls: unknown[] = [];
  const listResult = [{ browserId: "b-1" }];
  const listError = new Error("list backend offline");
  let failList = false;
  const original = {
    marker: "original",
    list(input: unknown) {
      assert.equal(this, original, "list must run with the original executor as this");
      listCalls.push(input);
      return failList ? Promise.reject(listError) : Promise.resolve(listResult);
    },
    async execute(_input: unknown) {
      return {
        ok: true,
        image: { base64: Buffer.from(PNG_BYTES).toString("base64"), mimeType: "image/png" },
      };
    },
  };
  const wrapped = instrumentBrowserExecutorForArtifacts({ executor: original, registry });

  assert.equal(typeof wrapped.list, "function");
  assert.equal(wrapped.marker, "original");
  const listInput = { requestId: "r-1", sessionId: TASK_ID };
  assert.equal(await wrapped.list(listInput), listResult);
  assert.deepEqual(listCalls, [listInput]);
  assert.equal(listCalls[0], listInput, "arguments pass through by identity");
  failList = true;
  await assert.rejects(wrapped.list(listInput), (error) => error === listError);

  const executed = await wrapped.execute({
    sessionId: TASK_ID,
    turnId: "turn-iface",
    workspacePath: WORKSPACE_A,
  } as never);
  assert.deepEqual(executed.artifactDelivery, { status: "delivered" });
  const list = await registry.listTaskArtifacts({ taskId: TASK_ID, workspacePath: WORKSPACE_A });
  assert.equal(list.artifacts.length, 1);
});

test("browser-use saved-path screenshot registers without leaking its host path", async () => {
  const { registry, dir } = await makeRegistry();
  try {
    const hostPath = path.join(dir, "electron-screenshot.png");
    await writeFile(hostPath, PNG_BYTES);
    const executor = {
      async execute() {
        return { ok: true, image: { hostPath, fileName: "nike.png", mimeType: "image/png" } };
      },
    };
    const instrumented = instrumentBrowserExecutorForArtifacts({
      executor: executor as never,
      registry,
    });
    const delivered = await instrumented.execute({
      sessionId: TASK_ID,
      workspacePath: WORKSPACE_A,
    } as never);
    assert.deepEqual(delivered.artifactDelivery, { status: "delivered" });
    assert.equal("hostPath" in (delivered.image ?? {}), false);
    const list = await registry.listTaskArtifacts({ taskId: TASK_ID, workspacePath: WORKSPACE_A });
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0]?.fileName, "nike.png");
    assert.ok(!JSON.stringify(list).includes(hostPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser-use bytes win over saved path so both forms create one artifact", async () => {
  const { registry, dir } = await makeRegistry();
  try {
    const hostPath = path.join(dir, "different.png");
    await writeFile(hostPath, Uint8Array.from([9, 9, 9]));
    const executor = {
      async execute() {
        return {
          ok: true,
          image: {
            base64: Buffer.from(PNG_BYTES).toString("base64"),
            hostPath,
            mimeType: "image/png",
          },
        };
      },
    };
    const instrumented = instrumentBrowserExecutorForArtifacts({
      executor: executor as never,
      registry,
    });
    const delivered = await instrumented.execute({
      sessionId: TASK_ID,
      turnId: "turn-both",
      workspacePath: WORKSPACE_A,
    } as never);
    assert.deepEqual(delivered.artifactDelivery, { status: "delivered" });
    assert.equal("hostPath" in (delivered.image ?? {}), false);
    await instrumented.execute({
      sessionId: TASK_ID,
      turnId: "turn-both",
      workspacePath: WORKSPACE_A,
    } as never);
    const list = await registry.listTaskArtifacts({ taskId: TASK_ID, workspacePath: WORKSPACE_A });
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0]?.byteSize, PNG_BYTES.byteLength);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registerTaskArtifact rejects oversized and empty payloads", async () => {
  const { registry } = await makeRegistry();
  await assert.rejects(
    registry.registerTaskArtifact({
      taskId: TASK_ID,
      scope: { workspacePath: WORKSPACE_A },
      origin: "tool",
      fileName: "big.png",
      mimeType: "image/png",
      bytes: new Uint8Array(TASK_ARTIFACT_MAX_BYTES + 1),
    }),
    (error: TaskArtifactRegistrationError) => error.reasonCode === "artifact_too_large",
  );
  await assert.rejects(
    registry.registerTaskArtifact({
      taskId: TASK_ID,
      scope: { workspacePath: WORKSPACE_A },
      origin: "tool",
      fileName: "empty.png",
      mimeType: "image/png",
      bytes: new Uint8Array(0),
    }),
    (error: TaskArtifactRegistrationError) => error.reasonCode === "artifact_too_large",
  );
});

// ── Codex 用户点名交付（真实 service + fake bridge，零推理） ──

function makeCodexHarness(registry: TaskArtifactRegistry, workspace: string) {
  const taskMeta: ZCodeTaskMeta = {
    taskId: TASK_ID,
    traceId: `codex-${TASK_ID}`,
    title: "delivery drill",
    workspacePath: workspace,
    createdAt: 1,
    updatedAt: 2,
    mode: "build",
    executionBackend: "codex",
    codexThreadId: "thread-1",
  };
  const rows = new Map<string, ZCodeTaskMeta>();
  rows.set(TASK_ID, taskMeta);
  const taskIndex: CodexTaskIndexPort = {
    async syncTaskMeta(params) {
      rows.set(params.meta.taskId, params.meta);
      return params.meta;
    },
    async updateTaskState(params) {
      const existing = rows.get(params.taskId);
      if (existing) rows.set(params.taskId, { ...existing, ...params.patch });
      return rows.get(params.taskId)!;
    },
    async getTaskMeta(params) {
      return rows.get(params.taskId) ?? null;
    },
    async listTaskMetas() {
      return [...rows.values()];
    },
  };
  const bridge: CodexAppServerPort = {
    get installed() {
      return true;
    },
    get generation() {
      return 1;
    },
    async call(method: string) {
      if (method === "account/read") {
        return { account: { type: "chatgpt", email: "u@example.com", planType: "plus" } };
      }
      if (method === CODEX_METHODS.threadStart) return { thread: { id: "thread-1" } };
      if (method === CODEX_METHODS.turnStart) return { turn: { id: "turn-codex-1" } };
      return {};
    },
    respond() {},
    onNotification() {
      return () => {};
    },
  };
  const service = createCodexExecutionService({
    bridge,
    taskIndex,
    policy: DEFAULT_CODEX_EXECUTION_POLICY,
    taskArtifacts: registry,
  }).service;
  return { service };
}

test("codex user-named matching: named file selected, unnamed edits never", () => {
  assert.deepEqual(
    selectUserNamedDeliverables({
      userInputText: "please send me nike_fullpage.png",
      filePaths: ["nike_fullpage.png", "src/untouched.ts"],
    }),
    ["nike_fullpage.png"],
  );
  assert.deepEqual(
    selectUserNamedDeliverables({ userInputText: "fix the bug", filePaths: ["src/untouched.ts"] }),
    [],
  );
  // 相对路径点名也命中。
  assert.deepEqual(
    selectUserNamedDeliverables({
      userInputText: "send docs/summary.md when done",
      filePaths: ["docs/summary.md", "notes.md"],
    }),
    ["docs/summary.md"],
  );
});

test("deliverUserNamedCodexArtifacts end-to-end via notification path registers only the named file", async () => {
  const { registry, dir } = await makeRegistry();
  try {
    await mkdir(WORKSPACE_A, { recursive: true });
    await writeFile(path.join(WORKSPACE_A, "proof.png"), Buffer.from(PNG_BYTES));
    await writeFile(path.join(WORKSPACE_A, "other.md"), "x");
    const { service } = makeCodexHarness(registry, WORKSPACE_A);
    const created = await service.createTask({ workspacePath: WORKSPACE_A });
    const taskId = created.task.taskId;
    // 开启一轮：投影进入 delivery 追踪。
    await service.sendConversationCommandV4({
      envelope: {
        commandId: "c-1",
        clientId: "client-1",
        sessionId: taskId,
        type: "sendText",
        payload: { text: "send me proof.png" },
        issuedAt: 0,
      },
    });
    // 从 impl 的 onNotification 无法直接触达（fake bridge 未保存 handler），改为
    // 通过 CodexThreadProjection + 集成函数的组合验证：
    const { CodexThreadProjection } = await import("../src/codex/domain/codexProjection.js");
    const { deliverUserNamedCodexArtifacts } =
      await import("../src/codex/app/codexDeliveryIntegration.js");
    const projection = new CodexThreadProjection("codex-test", () => 0);
    projection.beginUserTurn({ text: "send me proof.png", turnId: "turn-1", commandId: "c-1" });
    projection.applyNotification({
      type: "itemCompleted",
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        kind: "fileChange",
        itemId: "fc-1",
        changes: [
          { path: "proof.png", kind: "add" },
          { path: "other.md", kind: "add" },
        ],
        status: "completed",
      },
    });
    const delivery = projection.takeCompletedTurnDelivery();
    assert.ok(delivery);
    const commits: unknown[] = [];
    await deliverUserNamedCodexArtifacts({
      registry,
      taskId,
      workspacePath: WORKSPACE_A,
      projection,
      delivery,
      emitCommit: () => commits.push(1),
    });
    const list = await registry.listTaskArtifacts({ taskId, workspacePath: WORKSPACE_A });
    assert.deepEqual(
      list.artifacts.map((artifact: TaskArtifactDescriptor) => artifact.fileName),
      ["proof.png"],
    );
    assert.equal(commits.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTaskArtifact preserves MIME and chunks bytes in order", async () => {
  const { registry } = await makeRegistry();
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const registered = await registry.registerTaskArtifact({
    taskId: TASK_ID,
    scope: { workspacePath: WORKSPACE_A },
    origin: "tool",
    fileName: "data.bin.png",
    mimeType: "image/png",
    bytes,
  });
  const first = await registry.readTaskArtifact({
    taskId: TASK_ID,
    artifactId: registered.artifact.artifactId,
    offset: 0,
    limit: 3,
    workspacePath: WORKSPACE_A,
  });
  assert.equal(first.totalBytes, 8);
  assert.equal(first.mediaType, "image/png");
  assert.equal(first.nextOffset, 3);
  const second = await registry.readTaskArtifact({
    taskId: TASK_ID,
    artifactId: registered.artifact.artifactId,
    offset: first.nextOffset!,
    limit: 99,
    workspacePath: WORKSPACE_A,
  });
  assert.equal(second.nextOffset, null);
  const merged =
    Buffer.from(first.dataBase64, "base64").toString("hex") +
    Buffer.from(second.dataBase64, "base64").toString("hex");
  assert.equal(merged, Buffer.from(bytes).toString("hex"));
  // 注册元数据与读取上限
  assert.ok(TASK_ARTIFACT_MAX_BYTES > 0);
  const stored = await readFile(
    path.join(registry.rootDir, TASK_ID, `${registered.artifact.artifactId}.bin`),
  );
  assert.deepEqual([...stored], [...bytes]);
});
