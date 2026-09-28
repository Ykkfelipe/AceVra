/**
 * bugfix 回归：设置页 Model Settings 的连通性测试曾把探测请求的 maxOutputTokens 压到 1，
 * 而部分 provider（观测到的是 Azure OpenAI 的 Responses API）服务端会直接以
 * "Invalid 'max_output_tokens': ... Expected a value >= 16, but got 1 instead" 拒绝这类请求。
 * 结果是一个真正能正常对话的 provider（同一份配置直接发起真实请求可以拿到回复）在设置页却被
 * 判定为"连接失败"。这里锁住探测预算的下限，防止再退化成对某些 provider 必然失败的固定值。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/core/test/workspace-generate-text-connectivity-probe.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS } from "../src/runtime/methods/workspace-generate-text.js";

test("the connectivity probe's output budget clears the known real-world provider minimum with margin", () => {
  // 已在 Azure OpenAI Responses API 上观测到的服务端下限是 16；这里要求明显大于它，
  // 而不是刚好等于，因为推理型模型的输出预算还要先扣掉推理 token 才轮到正文。
  const OBSERVED_PROVIDER_MINIMUM = 16;
  assert.ok(
    CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS > OBSERVED_PROVIDER_MINIMUM * 2,
    `connectivity probe budget (${CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS}) must stay well above the observed provider minimum (${OBSERVED_PROVIDER_MINIMUM})`,
  );
});
