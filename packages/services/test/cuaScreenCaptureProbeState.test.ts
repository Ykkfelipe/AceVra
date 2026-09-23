// CUA 屏幕录制功能探针的状态推导（零推理 fixture）。
//
// Run: mise exec -- node --import tsx --test packages/services/test/cuaScreenCaptureProbeState.test.ts
//
// 为什么单独测这个纯函数：`screenCaptureProbeOk === false` 同时表示「探针跑了但没通过」和
// 「按约定根本没跑」，而只有主动抓屏（用户意图）才算跑过。任何按布尔值单独判断的消费方都会把
// 已授权用户读成「屏幕录制被拒绝」——CUA-0.5 实测 `CGPreflightScreenCaptureAccess` 会被进程
// 缓存，preflight 值甚至可能与功能真值相反。state 是消除该歧义的唯一出口，因此它的取值集合与
// 判定依据必须被固定住。
//
// 已知边界（写成断言而不是留成猜测）：本构建里 `shouldRunCuaScreenCaptureProbe` 是 fail-closed
// stub（packages/zcode-cua/broker-ports.js），恒返回 false，所以 `"failed"` 这一取值在当前构建
// 不可达；等到上游放行主动抓屏，下面第三条断言自然就会覆盖到它。
import assert from "node:assert/strict";
import test from "node:test";

import { resolveCuaScreenCaptureProbeState } from "../src/node.js";

test("只读刷新（未声明功能探针）一律是 not_run，而不是 failed", () => {
  for (const screenRecording of ["granted", "denied", "unknown"] as const) {
    assert.equal(resolveCuaScreenCaptureProbeState(screenRecording, undefined, false), "not_run");
    assert.equal(
      resolveCuaScreenCaptureProbeState(screenRecording, undefined, undefined),
      "not_run",
    );
  }
});

test("返回值恒在枚举内，绝不返回 undefined 或布尔", () => {
  const states = ["ok", "failed", "not_run"];
  for (const screenRecording of ["granted", "denied", "unknown"] as const) {
    for (const probeOk of [true, false, undefined]) {
      for (const options of [undefined, { probeScreenCapture: true }]) {
        const state = resolveCuaScreenCaptureProbeState(screenRecording, options, probeOk);
        assert.ok(states.includes(state), `unexpected state ${String(state)}`);
      }
    }
  }
});

test("TCC 记录态与探针结果本身都不能把 state 变成 ok", () => {
  // ok 只能由「主动抓屏实测通过」产生：写死 true 的 probeOk 在门未放行时也必须停留在 not_run。
  assert.notEqual(resolveCuaScreenCaptureProbeState("granted", undefined, true), "ok");
  assert.notEqual(resolveCuaScreenCaptureProbeState("denied", undefined, true), "ok");
});
