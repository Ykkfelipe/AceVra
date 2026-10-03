import assert from "node:assert/strict";
import { test } from "node:test";
import { createContextBuilder } from "../src/context/builder.js";
import { buildResponseLanguageSection } from "../src/context/sections/response-language.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";

const ENV_INFO = {
  cwd: "/workspace/example",
  platform: "linux",
  shell: "bash",
  osVersion: "linux test",
  nodeVersion: "v24.14.0",
  isGitRepository: false,
};

const PROMPTS = [
  {
    prompt: "Can you inspect this bug?",
    policyExample: "an English request calls for English",
  },
  {
    prompt: "¿Puedes revisar este error?",
    policyExample: "a Spanish request calls for Spanish",
  },
  { prompt: "请解释这个错误", policyExample: "a Chinese request calls for Chinese" },
  {
    prompt: "Explain this to me in Spanish",
    policyExample: "'Explain this to me in Spanish' calls for Spanish",
  },
] as const;

function getPolicy(result: ReturnType<ReturnType<typeof createContextBuilder>["build"]>): string {
  const section = result.sections.find((candidate) => candidate.source === "response_language");
  assert.ok(section, "response language policy is present in the assembled context");
  assert.equal(section.injectionTarget, "system");
  return section.content;
}

test("provider-visible policy selects the latest request language and preserves technical text", () => {
  const policy = buildResponseLanguageSection().content;

  for (const { prompt, policyExample } of PROMPTS) {
    assert.ok(prompt.length > 0, "acceptance example has a latest user request");
    assert.match(policy, /primary natural language of the user's latest user-authored request/);
    assert.match(policy, /explicitly asks you to answer in another language/);
    assert.ok(policy.includes(policyExample), `policy covers: ${prompt}`);
  }

  assert.match(policy, /an English request calls for English/);
  assert.match(policy, /a Spanish request calls for Spanish/);
  assert.match(policy, /a Chinese request calls for Chinese/);
  assert.match(policy, /'Explain this to me in Spanish' calls for Spanish/);
  assert.match(policy, /Internally generated prompts for machine contracts are not user requests/);
  assert.match(policy, /Do not infer it from the UI locale/);
  assert.match(policy, /system or workspace instructions/);
  assert.match(policy, /earlier conversation messages/);
  assert.match(policy, /tool output, source code, terminal output, or technical documentation/);
  // 回归：中文 AGENTS.md 以 meta_user 注入后，模型曾整段用中文回答英文请求。
  // 规则必须是硬要求，并点名指令文件语言不得影响回答语言。
  assert.match(policy, /This is a hard requirement, not a preference/);
  assert.match(policy, /workspace instruction files \(AGENTS\.md, CLAUDE\.md and similar\)/);
  assert.match(policy, /must never change, override or dilute the language of your reply/);
  assert.match(policy, /An English request is answered in English/);
  assert.match(policy, /Preserve code, commands, paths, identifiers, API names, and model names/);
});

test("English UI with a Spanish request and Chinese UI with an English request share the same policy", () => {
  const englishUi = createContextBuilder({
    workingDirectory: "/workspace/example",
    envInfo: ENV_INFO,
    language: "en-US",
  }).build();
  const chineseUi = createContextBuilder({
    workingDirectory: "/workspace/example",
    envInfo: ENV_INFO,
    language: "zh-CN",
  }).build();

  assert.equal(getPolicy(englishUi), getPolicy(chineseUi));
  assert.match(getPolicy(englishUi), /latest request/);
});

test("Chinese workspace instructions stay separate from the response language system policy", () => {
  const result = createContextBuilder({
    workingDirectory: "/workspace/example",
    envInfo: ENV_INFO,
    userInstructions: {
      filePath: "/workspace/example/AGENTS.md",
      fileName: "AGENTS.md",
      content: "新增行为前更新 spec。",
      bytesRead: 20,
      sizeBytes: 20,
      truncated: false,
    },
  }).build();

  assert.match(getPolicy(result), /Do not infer it from the UI locale/);
  assert.match(result.metaUserAttachments[0]?.content ?? "", /新增行为前更新 spec/);
  assert.ok(
    result.systemMessages.every((message) => !message.content.includes("新增行为前更新 spec")),
  );
});

test("custom prompts and workflow actors receive the canonical policy", () => {
  const customPrompt = createContextBuilder({
    workingDirectory: "/workspace/example",
    envInfo: ENV_INFO,
    customSystemPrompt: "You are a specialist assistant.",
  }).build();
  const workflowActor = createContextBuilder({
    workingDirectory: "/workspace/example",
    envInfo: ENV_INFO,
    workflowActor: { name: "reviewer" },
  }).build();

  assert.match(getPolicy(customPrompt), /latest request/);
  assert.match(getPolicy(workflowActor), /latest request/);
});

test("saved subagent contexts receive the same canonical policy", () => {
  const result = createSubagentContextBuilder({
    agentPrompt: "Review the changed files.",
    envInfo: ENV_INFO,
  }).build();
  const policy = result.sections.find((section) => section.source === "response_language");

  assert.ok(policy);
  assert.ok(result.systemMessages.some((message) => message.content.includes(policy.content)));
  assert.match(
    policy.content,
    /Preserve code, commands, paths, identifiers, API names, and model names/,
  );
});

test("changing providers or the legacy runtime language value cannot pin the previous language", () => {
  const agentA = createContextBuilder({
    workingDirectory: "/workspace/example",
    envInfo: ENV_INFO,
    language: "zh-CN",
    model: { providerId: "provider-a", modelId: "model-a" } as never,
  }).build();
  const agentB = createContextBuilder({
    workingDirectory: "/workspace/example",
    envInfo: ENV_INFO,
    language: "en-US",
    model: { providerId: "provider-b", modelId: "model-b" } as never,
  }).build();

  assert.equal(getPolicy(agentA), getPolicy(agentB));
  assert.doesNotMatch(getPolicy(agentB), /provider-a|model-a|zh-CN/);
});
