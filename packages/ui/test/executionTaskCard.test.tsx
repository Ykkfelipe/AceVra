/**
 * Conversation work card (acevra-agent-computer.md M1). The card is a pure projection of
 * TaskView/TaskEvents: it shows "<computer> · <status>" in plain words, the latest lines and Stop,
 * and never the executable/args/cwd or task/execution jargon. Rendering never starts a task.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { ExecutionTaskCardView } = await import("../src/v4/composer/ExecutionTaskCards.js");

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
  assert.match(markup, /Working/);
  const visibleText = markup.replace(/<[^>]+>/g, " ");
  assert.doesNotMatch(visibleText, /Running|task|execution|command/i);
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
  assert.match(markup, /Couldn(&#x27;|')t finish/);
  assert.match(markup, /code 2/);
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
  assert.match(markup, /工作中/);
});

test("plain status words: Done and Stopped, localized in Chinese", () => {
  const card = (id: "completed" | "cancelled", locale: "en-US" | "zh-CN" = "en-US") =>
    render(
      <ExecutionTaskCardView
        taskId="t1"
        targetName="Dell"
        status={{ id, active: false }}
        lines={[]}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
      locale,
    );
  assert.match(card("completed"), /Dell<\/span>.*· .*Done/s);
  assert.match(card("cancelled"), /Stopped/);
  assert.match(card("completed", "zh-CN"), /完成/);
  assert.match(card("cancelled", "zh-CN"), /已停止/);
});
