import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getZCodeToolFamilyForName } from "@zcode/shared";
import { isCreateWorkflowToolCall, isMultitaskToolCall } from "../src/lib/workflowToolNames.js";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const enUS = (await import("../src/i18n/locales/en-US.js")).default;
const { WorkflowToolSummary } = await import("../src/v4/WorkflowToolSummary.js");

test("Multitask uses Workflow identity and joins while preserving its product name", () => {
  assert.equal(getZCodeToolFamilyForName("Multitask"), "workflow");
  assert.equal(isMultitaskToolCall({ toolName: "Multitask" }), true);
  assert.equal(isCreateWorkflowToolCall({ toolName: "Multitask" }), true);
  assert.equal(isMultitaskToolCall({ toolName: "CreateWorkflow" }), false);
  const summary = { runId: "run-m1", status: "running", agents: 2 } as Parameters<
    typeof WorkflowToolSummary
  >[0]["summary"];
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US" messages={enUS}>
      <WorkflowToolSummary toolCallId="call-m1" summary={summary} multitask onOpen={() => {}} />
    </ZCodeIntlProvider>,
  );
  assert.match(markup, /Multitask/);
  assert.match(markup, /data-workflow-run-id="run-m1"/);
  assert.match(markup, /2/);
  assert.match(markup, /button/);
});
