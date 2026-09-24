import assert from "node:assert/strict";
import test from "node:test";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";

/** composerDraftStore 只经 window.localStorage 落盘；测试里注入最小内存实现。 */
function installMemoryStorage(): Map<string, string> {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, value),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return data;
}

test("codex model draft roundtrips curated ids and the null default sentinel", () => {
  const data = installMemoryStorage();
  try {
    persistV4ComposerDraft("/tmp/ws", undefined, "__draft__", {
      text: "",
      executionBackend: "codex",
      codexModelId: "gpt-6-luna",
      updatedAt: 0,
    });
    const curated = readV4ComposerDraft("/tmp/ws", undefined, "__draft__");
    assert.equal(curated?.codexModelId, "gpt-6-luna");
    assert.equal(curated?.executionBackend, "codex");

    persistV4ComposerDraft("/tmp/ws", undefined, "__draft__", {
      text: "hi",
      executionBackend: "codex",
      codexModelId: null,
      codexEffort: "high",
      updatedAt: 0,
    });
    const sentinel = readV4ComposerDraft("/tmp/ws", undefined, "__draft__");
    assert.equal(sentinel?.codexModelId, null);
    assert.equal(sentinel?.codexEffort, "high");
  } finally {
    data.clear();
    delete (globalThis as { window?: unknown }).window;
  }
});

test("unknown codex model ids are dropped from persisted drafts", () => {
  const data = installMemoryStorage();
  try {
    data.set(
      "zcode-v4-composer-drafts:v1:%2Ftmp%2Fws",
      JSON.stringify({
        version: 1,
        scopes: {
          __draft__: { text: "", executionBackend: "codex", codexModelId: "gpt-4o", updatedAt: 1 },
        },
      }),
    );
    const draft = readV4ComposerDraft("/tmp/ws", undefined, "__draft__");
    assert.equal(draft?.codexModelId, undefined);
    assert.equal(draft?.executionBackend, "codex");
  } finally {
    data.clear();
    delete (globalThis as { window?: unknown }).window;
  }
});
