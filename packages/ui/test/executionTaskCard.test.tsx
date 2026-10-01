/**
 * Live work card + Run-on control rendering (M2E). The card is a pure projection of
 * TaskView/TaskEvents: it shows "<target> · <status>", the latest lines and Stop, and never the
 * executable/args/cwd. Rendering never starts a task.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { ExecutionTaskCardView } = await import("../src/v4/composer/ExecutionTaskCards.js");
const { RunOnRemoteCaption, V4ComposerRunOnControl } =
  await import("../src/v4/composer/V4ComposerRunOnControl.js");

const render = (node: React.ReactNode, locale: "en-US" | "zh-CN" = "en-US") =>
  renderToStaticMarkup(<ZCodeIntlProvider initialLocale={locale}>{node}</ZCodeIntlProvider>);

test("running card shows target, status, latest lines and Stop — not the command line", () => {
  const markup = render(
    <ExecutionTaskCardView
      taskId="t1"
      targetName="Dell Runner"
      status={{ id: "running", active: true }}
      lines={[{ key: "3:0", text: "71 tests discovered", stream: "stdout" }]}
      onStop={() => {}}
      onDismiss={() => {}}
    />,
  );
  assert.match(markup, /Dell Runner/);
  assert.match(markup, /Running/);
  assert.match(markup, /71 tests discovered/);
  assert.match(markup, /data-testid="acevra-task-card-stop"/);
  assert.doesNotMatch(markup, /acevra-task-card-dismiss/);
  assert.match(markup, /data-task-status="running"/);
});

test("finished card offers dismiss instead of Stop and reports the exit code", () => {
  const markup = render(
    <ExecutionTaskCardView
      taskId="t1"
      targetName="Dell Runner"
      status={{ id: "failed", active: false, exitCode: 2 }}
      lines={[]}
      onStop={() => {}}
      onDismiss={() => {}}
    />,
  );
  assert.match(markup, /Failed/);
  assert.match(markup, /exit 2/);
  assert.doesNotMatch(markup, /acevra-task-card-stop/);
  assert.match(markup, /acevra-task-card-dismiss/);
});

test("status text is localized, not hardcoded English", () => {
  const markup = render(
    <ExecutionTaskCardView
      taskId="t1"
      targetName="Dell"
      status={{ id: "running", active: true }}
      lines={[]}
      onStop={() => {}}
      onDismiss={() => {}}
    />,
    "zh-CN",
  );
  assert.doesNotMatch(markup, />Running</);
  assert.doesNotMatch(markup, />Stop</);
});

test("Run-on control renders nothing without a desktop account bridge", () => {
  assert.equal(render(<V4ComposerRunOnControl scopeKey="draft:/w" />), "");
});

test("remote selection caption names the target and the local-only tools (M2F)", () => {
  const en = render(<RunOnRemoteCaption targetName="Dell Runner" />);
  assert.match(en, /data-testid="v4-composer-run-on-gap"/);
  assert.match(
    en,
    /Commands the agent runs go to Dell Runner\. Files and Computer stay on this device\./,
  );
  assert.doesNotMatch(en, /still run on this device/);
  const zh = render(<RunOnRemoteCaption targetName="Dell Runner" />, "zh-CN");
  assert.match(zh, /智能体运行的命令将在 Dell Runner 上执行。文件和 Computer 仍在本机。/);
});
