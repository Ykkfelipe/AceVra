import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { register } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { UnavailableWorkspaceNotice } =
  await import("../src/app-shell/UnavailableWorkspaceNotice.js");
const { resolvePaneReadOnlyComposerNotice } =
  await import("../src/v4/paneReadOnlyComposerNotice.js");

const WORKSPACE_PATH = "/Users/dev/Projects/deleted-project";
const noop = () => {};

function renderNotice(
  locale: "en-US" | "zh-CN",
  props: { onOpenFolder?: () => void; onRemoveProject?: () => void },
): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={locale}>
      <UnavailableWorkspaceNotice workspacePath={WORKSPACE_PATH} {...props} />
    </ZCodeIntlProvider>,
  );
}

function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

test("notice explains the missing folder with its path and both actions (en-US)", () => {
  const html = renderNotice("en-US", { onOpenFolder: noop, onRemoveProject: noop });
  assert.match(html, /role="status"/u);
  assert.match(html, /data-testid="unavailable-workspace-notice"/u);
  assert.match(html, /This project&#x27;s folder can&#x27;t be found/u);
  assert.match(html, new RegExp(WORKSPACE_PATH, "u"));
  assert.match(html, /Restore it and restart the app/u);
  assert.match(html, /data-testid="unavailable-workspace-notice-open-folder"[^>]*>.*Open folder/su);
  assert.match(html, /data-testid="unavailable-workspace-notice-remove"[^>]*>.*Remove project/su);
  // 持续状态说明不是打断式告警；沿用 dock 提示条 surface，不铺 warning/destructive 底色。
  assert.doesNotMatch(html, /role="alert"/u);
  assert.match(html, /^<div role="status"[^>]*class="[^"]*\bbg-surface\b/u);
  assert.doesNotMatch(html, /\bbg-(?:warning|destructive)\b/u);
});

test("notice is localized in zh-CN and keeps the path verbatim", () => {
  const html = renderNotice("zh-CN", { onOpenFolder: noop, onRemoveProject: noop });
  assert.match(html, /找不到此项目的文件夹/u);
  assert.match(html, /打开文件夹/u);
  assert.match(html, /移除项目/u);
  assert.match(html, new RegExp(WORKSPACE_PATH, "u"));
  assert.doesNotMatch(html, /workspace\.unavailableNotice\./u);
});

test("notice hides actions whose handler is not provided", () => {
  const removeOnly = renderNotice("en-US", { onRemoveProject: noop });
  assert.doesNotMatch(removeOnly, /unavailable-workspace-notice-open-folder/u);
  assert.match(removeOnly, /unavailable-workspace-notice-remove/u);

  const noActions = renderNotice("en-US", {});
  assert.doesNotMatch(noActions, /<button/u);
  assert.match(noActions, new RegExp(WORKSPACE_PATH, "u"));
});

test("pane forwards the notice only when read-only comes from the shell workspace", () => {
  const notice = "notice";
  const cases = [
    { isShellWorkspace: true, shellReadOnly: true, bindingReadOnly: false, expected: notice },
    // subagent 观察视图等 pane 自身只读：保持原样，无说明。
    { isShellWorkspace: true, shellReadOnly: true, bindingReadOnly: true, expected: undefined },
    // 其他 workspace 的 pane 不受 shell 只读影响。
    { isShellWorkspace: false, shellReadOnly: true, bindingReadOnly: false, expected: undefined },
    { isShellWorkspace: true, shellReadOnly: false, bindingReadOnly: false, expected: undefined },
    { isShellWorkspace: true, shellReadOnly: false, bindingReadOnly: true, expected: undefined },
  ];
  for (const { expected, ...input } of cases) {
    assert.equal(
      resolvePaneReadOnlyComposerNotice({ ...input, notice }),
      expected,
      JSON.stringify(input),
    );
  }
});

test("session pane renders the notice only in the read-only dock branch", async () => {
  const source = await readSource("v4/SessionPane.tsx");
  assert.match(
    source,
    /conversationBottomDockContent\s*=\s*readOnly\s*\?\s*\(?\s*\(?readOnlyComposerNotice\s*\?\?\s*null\)?/u,
  );
  // composer 的只读语义不变。
  assert.match(source, /const composerNode = readOnly \? null :/u);
});

test("sidebar menu and notice share one project removal transaction", async () => {
  for (const file of [
    "WorkspaceSidebarItem.tsx",
    "app-shell/UnavailableWorkspaceComposerNotice.tsx",
  ]) {
    const source = await readSource(file);
    assert.match(source, /useWorkspaceTabRemoval\(/u, file);
    assert.doesNotMatch(source, /closeTab\(/u, file);
  }
});
