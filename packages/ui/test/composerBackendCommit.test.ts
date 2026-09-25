/**
 * 迁移提交后的 composer 投影（backend-migration.md Amendment 5）。
 *
 * 复现的线上缺陷：Agent/Command Code → Codex → Agent/Azure 提交后，已有 task 的草稿仍持有
 * Command Code，composer 显示它、下一轮也提交它，runtime 被改回 Command Code，下一个
 * Agent → Codex 标记因此写成 "Command Code → Codex"。这里走真实的显示链：持久化记录 →
 * Host 时间线视图 → 草稿 owner 的一次性投影 → composer 的 Provider/模型文案与迁移分隔线文案。
 *
 * Run: TSX_TSCONFIG_PATH=packages/ui/tsconfig.json mise exec -- node --import tsx --test packages/ui/test/composerBackendCommit.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackendTransitionMarkerRow,
  buildTaskTimelineView,
  layoutFromTaskTimelineView,
  ZCODE_AGENT_PROVIDER,
  type BackendTransitionRecord,
  type ModelSelection,
  type TaskTimelineView,
  type ZCodeExecutionBackend,
} from "@zcode/shared";
import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import {
  applyComposerBackendCommit,
  resolveComposerCommittedBackend,
} from "../src/v4/composer/composerBackendCommit.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  type V4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";
import {
  buildComposerAgentProviderChoices,
  resolveComposerProviderChoiceKey,
} from "../src/v4/composer/composerProviderChoices.js";
import { resolveDraftDisplayedConfig } from "../src/v4/composer/draftWorkspaceDefaults.js";
import { resolveV4ModelTriggerDisplay } from "../src/v4/composer/modelTriggerDisplay.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelSelectScopeProviderIds,
} from "../src/lib/modelSelectionGroups.js";
import { encodeCustomModelValue } from "../src/lib/zcodeCustomModelValue.js";
import { formatBackendTransitionSwitchedLabel } from "../src/v4/backendTransitionMarkerLabel.js";
import enUS from "../src/i18n/locales/en-US.js";

const TASK_ID = "sess_migrated";
const WORKSPACE = "/example/workspace";
const COMMAND_CODE: ModelSelection = {
  providerId: "command-code",
  modelId: "gpt-5.6-sol",
  options: { reasoningLevel: "max" },
};
const AZURE_SELECTION = "azure-openai/gpt-5-mini$low";
const AZURE: ModelSelection = {
  providerId: "azure-openai",
  modelId: "gpt-5-mini",
  options: { reasoningLevel: "low" },
};

// ── localStorage 替身：草稿 owner 的持久化与「重启」读取走真实 composerDraftStore ──
const memory = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
};

const intl = {
  formatMessage(descriptor: { id: string }, values?: Record<string, unknown>): string {
    const template = (enUS as Record<string, string>)[descriptor.id] ?? descriptor.id;
    return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? ""));
  },
} as never;

function selectionProvider(providerId: string, providerName: string, models: readonly string[]) {
  return {
    providerId,
    templateId: "custom",
    providerName,
    config: { api: { type: "openai-completions" } } as never,
    models: models.map((modelId) => ({ modelId, config: {} as never })),
  } as ModelSelectionView["providers"][number];
}

const MODEL_SELECTION_VIEW: ModelSelectionView = {
  revision: 1,
  providers: [
    selectionProvider("command-code", "Command Code", ["gpt-5.6-sol"]),
    selectionProvider("azure-openai", "Azure OpenAI", ["gpt-5-mini", "gpt-5.4-nano"]),
  ],
};
const SETTINGS_VIEW: ProviderSettingsView = {
  revision: 1,
  providerTemplates: [],
  providerOrder: ["command-code", "azure-openai"],
  providers: [],
};

/** Host 在每次提交时追加的记录形状（与 backendTransitionStateMachine 产出的一致）。 */
function committed(
  from: ZCodeExecutionBackend,
  to: ZCodeExecutionBackend,
  extra: Partial<BackendTransitionRecord>,
  at: number,
): BackendTransitionRecord {
  return {
    startedAt: at,
    committedAt: at + 1,
    from,
    to,
    status: "committed",
    transcriptCompacted: false,
    ...extra,
  };
}

const TO_CODEX = committed(
  "zcode",
  "codex",
  {
    fromProviderId: "command-code",
    destinationExecutionRef: "thread-1",
    handoffTurnId: "turn-1",
    sourceFirstRowId: 1,
    sourceLastRowId: 9,
  },
  100,
);
const TO_AZURE = committed(
  "codex",
  "zcode",
  {
    toProviderId: "azure-openai",
    toModelSelection: AZURE_SELECTION,
    sourceExecutionRef: "thread-1",
    destinationSeedLastRowId: 9,
  },
  200,
);

function viewOf(
  records: readonly BackendTransitionRecord[],
  executionBackend: ZCodeExecutionBackend,
  model: string,
): TaskTimelineView {
  return buildTaskTimelineView({
    taskId: TASK_ID,
    executionBackend,
    ...(executionBackend === "codex" ? { codexThreadId: "thread-x" } : {}),
    backendTransitions: records,
    // meta.model 故意保持同步写入的有损形态（无 reasoning level）：投影不能依赖它。
    model,
  } as Parameters<typeof buildTaskTimelineView>[0]);
}

const ON_CODEX = viewOf([TO_CODEX], "codex", "command-code/gpt-5.6-sol");
const ON_AZURE = viewOf([TO_CODEX, TO_AZURE], "zcode", "azure-openai/gpt-5-mini");

/** 已有 task 的草稿：迁移前就存在，在 Codex 段时已记下布局 1，选择仍是 Command Code。 */
function staleDraft(): V4ComposerDraft {
  return {
    text: "",
    mode: "build",
    planEnabled: false,
    modelSelection: COMMAND_CODE,
    backendLayoutVersion: ON_CODEX.layoutVersion,
    updatedAt: 1,
  };
}

/** composer 实际的显示链：草稿选择 → 显示配置 → Provider 菜单文案 + 模型触发器文案。 */
function composerLabels(draft: V4ComposerDraft) {
  const config = resolveDraftDisplayedConfig({
    modelSelection: draft.modelSelection,
    mode: "build",
  });
  assert.ok(config, "the existing task has a displayed selection");
  const choices = buildComposerAgentProviderChoices(MODEL_SELECTION_VIEW, SETTINGS_VIEW);
  const providerLabel = choices.find(
    (choice) => choice.key === resolveComposerProviderChoiceKey(config.provider),
  )?.label;
  const groups = buildRegistryModelSelectGroups(
    ZCODE_AGENT_PROVIDER,
    MODEL_SELECTION_VIEW,
    {},
    resolveModelSelectScopeProviderIds(config.provider),
  );
  const model = resolveV4ModelTriggerDisplay({
    modelGroups: groups,
    normalizedValue: encodeCustomModelValue(config.provider, config.model),
    fallbackLabel: "Model",
    providerId: config.provider,
    providerName: MODEL_SELECTION_VIEW.providers.find((p) => p.providerId === config.provider)
      ?.providerName,
  });
  return { config, providerLabel, modelLabel: model.fullLabel };
}

function markerLabel(view: TaskTimelineView, segmentIndex: number): string {
  const row = buildBackendTransitionMarkerRow(layoutFromTaskTimelineView(view), segmentIndex);
  assert.ok(row && row.kind === "timelineMarker" && row.marker.type === "backendTransition");
  return formatBackendTransitionSwitchedLabel(row.marker, MODEL_SELECTION_VIEW, intl);
}

test("Agent/Command Code → Codex → Agent/Azure: the committed view projects Azure into the existing-task composer", () => {
  const before = composerLabels(staleDraft());
  assert.equal(before.providerLabel, "Command Code", "reproduces the stale pre-fix presentation");
  assert.equal(before.modelLabel, "Command Code/gpt-5.6-sol");

  const committedBackend = resolveComposerCommittedBackend(ON_AZURE);
  assert.equal(ON_AZURE.executionBackend, "zcode", "authoritative backend is Agent");
  assert.deepEqual(committedBackend, { layoutVersion: 2, agentModelSelection: AZURE });

  const draft = applyComposerBackendCommit(staleDraft(), committedBackend);
  assert.deepEqual(draft.modelSelection, AZURE, "model selection = azure-openai/gpt-5-mini$low");
  assert.equal(draft.backendLayoutVersion, 2);

  const after = composerLabels(draft);
  assert.equal(after.config.provider, "azure-openai");
  assert.equal(after.config.model, "gpt-5-mini");
  assert.equal(after.config.thought, "low");
  assert.equal(after.providerLabel, "Azure OpenAI");
  assert.equal(after.modelLabel, "Azure OpenAI/gpt-5-mini");
  assert.ok(
    ![after.providerLabel, after.modelLabel, after.config.provider].some((label) =>
      /command/i.test(label ?? ""),
    ),
    "no Command Code label remains",
  );
});

test("source of truth: a draft that still holds Command Code resolves to the persisted Azure commit", () => {
  // 本地草稿（持久化存储里）故意是 Command Code；Host 持久化的已提交状态是 Azure。
  persistV4ComposerDraft(WORKSPACE, undefined, TASK_ID, staleDraft());
  const local = readV4ComposerDraft(WORKSPACE, undefined, TASK_ID);
  assert.equal(local?.modelSelection?.providerId, "command-code");

  const resolved = applyComposerBackendCommit(local!, resolveComposerCommittedBackend(ON_AZURE));
  assert.equal(resolved.modelSelection?.providerId, "azure-openai");
  assert.equal(composerLabels(resolved).providerLabel, "Azure OpenAI");
});

test("next Agent → Codex marker names the Azure source, not Command Code", () => {
  // 修复后 Azure 段的轮次与种子都归属 Azure，任务行 model = Azure，Host 按它记下来源 provider。
  const toCodexAgain = committed(
    "zcode",
    "codex",
    {
      fromProviderId: "azure-openai",
      destinationExecutionRef: "thread-2",
      handoffTurnId: "turn-2",
      sourceFirstRowId: 10,
      sourceLastRowId: 13,
    },
    300,
  );
  const view = viewOf([TO_CODEX, TO_AZURE, toCodexAgain], "codex", "azure-openai/gpt-5-mini");
  assert.equal(view.transitions[2]?.fromProviderId, "azure-openai");
  assert.equal(markerLabel(view, 1), "Switched Agent · Command Code → Codex");
  assert.equal(markerLabel(view, 2), "Switched Codex → Agent · Azure OpenAI");
  const second = markerLabel(view, 3);
  assert.equal(second, "Switched Agent · Azure OpenAI → Codex");
  assert.ok(!second.includes("Command Code"));

  // Codex 段只记下布局，不改 Agent 选择；再迁回 Agent 时才按新的提交重新投影。
  const onCodex = applyComposerBackendCommit(
    applyComposerBackendCommit(staleDraft(), resolveComposerCommittedBackend(ON_AZURE)),
    resolveComposerCommittedBackend(view),
  );
  assert.equal(onCodex.backendLayoutVersion, 3);
  assert.deepEqual(onCodex.modelSelection, AZURE);
});

test("restart after Codex → Azure keeps projecting Azure and never re-applies over a later pick", () => {
  const projected = applyComposerBackendCommit(
    staleDraft(),
    resolveComposerCommittedBackend(ON_AZURE),
  );
  persistV4ComposerDraft(WORKSPACE, undefined, TASK_ID, projected);

  // 重启：内存全丢，草稿从持久化存储重新解析，Host 视图重新读取（同一布局）。
  const restarted = readV4ComposerDraft(WORKSPACE, undefined, TASK_ID)!;
  assert.equal(restarted.backendLayoutVersion, 2, "the projected layout survives restart");
  const reapplied = applyComposerBackendCommit(
    restarted,
    resolveComposerCommittedBackend(ON_AZURE),
  );
  assert.equal(reapplied, restarted, "same layout → no second projection");
  assert.equal(composerLabels(reapplied).modelLabel, "Azure OpenAI/gpt-5-mini");

  // 同一布局里的手动改选（provider 内换模型）跨重启保留，不会被已提交选择冲回去。
  const picked: V4ComposerDraft = {
    ...restarted,
    modelSelection: { providerId: "azure-openai", modelId: "gpt-5.4-nano" },
  };
  persistV4ComposerDraft(WORKSPACE, undefined, TASK_ID, picked);
  const again = applyComposerBackendCommit(
    readV4ComposerDraft(WORKSPACE, undefined, TASK_ID)!,
    resolveComposerCommittedBackend(ON_AZURE),
  );
  assert.equal(again.modelSelection?.modelId, "gpt-5.4-nano");
});

test("provider-only switching inside Agent is not overridden by the committed projection", () => {
  const onAzure = applyComposerBackendCommit(
    staleDraft(),
    resolveComposerCommittedBackend(ON_AZURE),
  );
  // 已上线的 Agent 内 provider 切换只写草稿选择，布局不变。
  const switched: V4ComposerDraft = { ...onAzure, modelSelection: COMMAND_CODE };
  const kept = applyComposerBackendCommit(switched, resolveComposerCommittedBackend(ON_AZURE));
  assert.equal(kept, switched);
  assert.equal(composerLabels(kept).providerLabel, "Command Code");
});

test("a draft with no recorded layout adopts the current one without replacing its selection", () => {
  // 新设备/新窗口：草稿由当前会话配置初始化，不比已提交布局旧。
  const fresh: V4ComposerDraft = {
    text: "",
    mode: "build",
    modelSelection: { providerId: "azure-openai", modelId: "gpt-5.4-nano" },
    updatedAt: 1,
  };
  const adopted = applyComposerBackendCommit(fresh, resolveComposerCommittedBackend(ON_AZURE));
  assert.equal(adopted.backendLayoutVersion, 2);
  assert.equal(adopted.modelSelection?.modelId, "gpt-5.4-nano");
  // 视图未知 / 草稿态：不做任何投影。
  assert.equal(applyComposerBackendCommit(fresh, resolveComposerCommittedBackend(null)), fresh);
});

test("a committed Agent segment without a recorded selection only records the layout", () => {
  const { toModelSelection: _omitted, ...legacy } = TO_AZURE;
  const view = viewOf([TO_CODEX, legacy], "zcode", "azure-openai/gpt-5-mini");
  assert.deepEqual(resolveComposerCommittedBackend(view), { layoutVersion: 2 });
  const draft = applyComposerBackendCommit(staleDraft(), resolveComposerCommittedBackend(view));
  assert.equal(draft.backendLayoutVersion, 2);
  assert.deepEqual(draft.modelSelection, COMMAND_CODE);
});
