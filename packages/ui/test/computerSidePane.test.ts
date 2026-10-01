/**
 * Computer is one more side-pane tab type (acevra-agent-computer.md §3.3): a single tab, a
 * launcher entry only when the platform has computers, and status/actions derived purely from
 * Main's ComputerView (the worker stays the authority).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerView } from "@zcode/shared";
import { resolveOpenTabLauncherItemIds } from "../src/app-shell/animatedSidePanePanelModel.js";
import {
  computerPaneActions,
  computerStatusKind,
  shouldStream,
} from "../src/computers/computerPaneModel.js";
import { openComputerSidePane, openTerminalSidePane } from "../src/lib/workspaceSidePane.js";

function view(partial: Partial<ComputerView>): ComputerView {
  return {
    computerId: "dell",
    name: "Dell",
    connection: "online",
    offlineReason: null,
    job: null,
    control: "idle",
    panelOwnsJob: false,
    lastAction: null,
    screen: { width: 1366, height: 768 },
    ...partial,
  };
}

const job = (yieldReason: string | null = null) => ({
  jobId: "j1",
  state: "running",
  mode: null,
  controller: "acevra-mac:session:s1",
  yieldReason,
});

test("Computer tab is a single tab that keeps its computer when reopened without one", () => {
  let state = openComputerSidePane(null, "dell");
  state = openTerminalSidePane(state, { title: "Terminal" });
  state = openComputerSidePane(state, null);
  const computerTabs = state.tabs.filter((tab) => tab.type === "computer");
  assert.equal(computerTabs.length, 1);
  assert.equal(state.activeTabId, "computer");
  assert.equal(computerTabs[0]?.type === "computer" && computerTabs[0].computerId, "dell");
  state = openComputerSidePane(state, "other");
  const retargeted = state.tabs.find((tab) => tab.type === "computer");
  assert.equal(retargeted?.type === "computer" && retargeted.computerId, "other");
});

test("launcher lists Computer only when the platform supports computers", () => {
  const base = { developerToolsEnabled: false, hasReviewTab: true };
  assert.deepEqual(resolveOpenTabLauncherItemIds(base), ["terminal", "browser"]);
  assert.deepEqual(resolveOpenTabLauncherItemIds({ ...base, supportsComputers: true }), [
    "terminal",
    "browser",
    "computer",
  ]);
});

test("status follows the worker-derived view", () => {
  assert.equal(computerStatusKind(null), "connecting");
  assert.equal(
    computerStatusKind(view({ connection: "offline", offlineReason: "not_connected" })),
    "connecting",
  );
  assert.equal(
    computerStatusKind(view({ connection: "offline", offlineReason: "auth_failed" })),
    "offline",
  );
  assert.equal(computerStatusKind(view({})), "idle");
  assert.equal(computerStatusKind(view({ control: "agent", job: job() })), "working");
  assert.equal(computerStatusKind(view({ control: "human", job: job() })), "inControl");
  assert.equal(
    computerStatusKind(view({ control: "paused", job: job("physical_input") })),
    "physicalPause",
  );
  assert.equal(computerStatusKind(view({ control: "paused", job: job() })), "paused");
});

test("actions: take control when online, give back in control, stop only for agent jobs", () => {
  assert.deepEqual(
    computerPaneActions(view({ connection: "offline", offlineReason: "unreachable" })),
    {
      takeControl: false,
      giveBack: false,
      resume: false,
      stop: false,
    },
  );
  assert.deepEqual(computerPaneActions(view({ control: "agent", job: job() })), {
    takeControl: true,
    giveBack: false,
    resume: false,
    stop: true,
  });
  assert.deepEqual(
    computerPaneActions(view({ control: "human", job: job(), panelOwnsJob: true })),
    { takeControl: false, giveBack: true, resume: false, stop: false },
  );
  assert.deepEqual(computerPaneActions(view({ control: "paused", job: job("physical_input") })), {
    takeControl: true,
    giveBack: false,
    resume: true,
    stop: true,
  });
});

test("the stream runs only for a visible tab with a chosen computer", () => {
  assert.equal(shouldStream("dell", true), true);
  assert.equal(shouldStream("dell", false), false);
  assert.equal(shouldStream(null, true), false);
});
