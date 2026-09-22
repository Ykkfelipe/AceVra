import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 视口高度契约测试（shell viewport-height contract）。
 *
 * 背景（/fork footer 裁切缺陷的根因）：视口高度只允许由根节点拥有
 * （#root { height:100dvh }、.fork-remote-shell { height:100dvh }）。
 * shell 链路上的组件若自声明 h-dvh / h-screen / min-h-dvh，在
 * /fork 连接 banner 占掉一行后会高于自身容器，整棵树超出
 * .fork-remote-shell__app 后被 overflow:hidden 裁掉底边——
 * 表现就是侧栏底部账号/Settings footer 被切一半、难以点击。
 *
 * 本测试读取源码做静态契约断言（仓库没有 DOM 测试基建），
 * 浏览器端的几何验证见 HANDOFF 的 probe 步骤。
 */

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

/** 去掉 // 行注释与 /* *\/ 块注释，避免注释里解释历史缺陷时提到类名造成误报。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function assertNoViewportUtility(relativePath: string): void {
  const code = stripComments(readSource(relativePath));
  assert.ok(
    !/\bh-dvh\b/.test(code),
    `${relativePath}: shell 组件不得自声明 h-dvh（视口高度只属于根节点，否则 /fork banner 下会裁切侧栏 footer）`,
  );
  assert.ok(
    !/\bh-screen\b/.test(code),
    `${relativePath}: shell 组件不得自声明 h-screen（同上）`,
  );
}

test("shell roots follow their container instead of declaring viewport height", () => {
  assertNoViewportUtility("DesktopWindowFrame.tsx");
  assertNoViewportUtility("root/RootShell.tsx");
  assertNoViewportUtility("SettingsPage.tsx");
  assertNoViewportUtility("onboarding/OccupationOnboarding.tsx");
  assertNoViewportUtility("WelcomeScreen.tsx");
  assertNoViewportUtility("root/RootStartupLoading.tsx");
});

test("DesktopWindowFrame and RootShell fill their container with h-full", () => {
  const frame = stripComments(readSource("DesktopWindowFrame.tsx"));
  assert.ok(/\bh-full\b/.test(frame), "DesktopWindowFrame 根节点需要 h-full 跟随容器");
  const shell = stripComments(readSource("root/RootShell.tsx"));
  assert.ok(/\bh-full\b/.test(shell), "RootShell 根节点需要 h-full 跟随容器");
});

test("sidebar footer stays shrink-0 with safe-area aware bottom padding", () => {
  const footer = stripComments(readSource("WorkspaceSidebarFooter.tsx"));
  // footer 必须在滚动容器之外且不可收缩：项目列表再长也不能把 footer 挤出侧栏。
  assert.ok(/\bshrink-0\b/.test(footer), "WorkspaceSidebarFooter 根节点必须保留 shrink-0");
  // 底边距必须叠加 env(safe-area-inset-bottom)，footer 不依赖屏幕最后几个物理像素。
  assert.ok(
    footer.includes("env(safe-area-inset-bottom)"),
    "WorkspaceSidebarFooter 底边距必须包含 env(safe-area-inset-bottom)",
  );
});

test("sidebar keeps nav on top, a dedicated scrolling task area, and the footer outside it", () => {
  const sidebar = stripComments(readSource("WorkspaceSidebar.tsx"));
  // 根 aside：纵向 flex 容器。
  assert.ok(
    sidebar.includes('className="flex h-full flex-col overflow-hidden"'),
    "侧栏根节点必须是纵向 flex 且自身不滚动（overflow-hidden）",
  );
  // 项目/任务区域：flex-1 + min-h-0 + 独立纵向滚动。
  const scrollMatch = sidebar.match(/ref=\{workspaceScrollRef\}[\s\S]{0,400}?\}/);
  assert.ok(scrollMatch, "找不到任务区滚动容器（workspaceScrollRef）");
  assert.ok(
    /\bflex-1\b/.test(scrollMatch[0]) &&
      /\bmin-h-0\b/.test(scrollMatch[0]) &&
      /\boverflow-y-auto\b/.test(scrollMatch[0]),
    "任务区必须是 flex-1 + min-h-0 + overflow-y-auto（仅该区域滚动）",
  );
  // footer 作为滚动区域的兄弟节点出现在其后，且不在滚动容器内部。
  const scrollStart = sidebar.indexOf("workspaceScrollRef");
  const footerIndex = sidebar.indexOf("<WorkspaceSidebarFooter");
  assert.ok(footerIndex > scrollStart, "footer 必须渲染在任务滚动区域之后（兄弟节点而非内部）");
});

test("the web entry splits device banner and app inside one height-owning flex column", () => {
  const web = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
  const code = stripComments(web);
  // banner 与 Root 必须共享一个 h-full 纵向 flex 容器，banner shrink-0，Root 槽位 flex-1。
  assert.ok(
    /flex h-full min-h-0 flex-col/.test(code),
    "web 入口需要用 h-full 纵向 flex 容器分配 banner 与应用的高度",
  );
  assert.ok(
    /shrink-0 border-b border-card-border bg-card/.test(code),
    "device banner 必须 shrink-0",
  );
  assert.ok(/min-h-0 w-full flex-1/.test(code), "Root 的槽位必须 min-h-0 flex-1");
});
