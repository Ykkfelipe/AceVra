import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const SENTINEL_KEY = "acevra-test-sentinel";
export async function createIsolatedRoots() {
  // Darwin 的 tmpdir 常有很长的用户随机前缀；Unix socket 必须使用短固定父目录。
  const root = await mkdtemp("/tmp/av-");
  const paths = {
    root,
    home: join(root, "h"),
    profile: join(root, "p"),
    userData: join(root, "u"),
    workspace: join(root, "w"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  if (Buffer.byteLength(join(paths.userData, "host-xxxxxxxxxxxxxxxx.sock")) >= 100)
    throw new Error("Isolated socket path too long");
  return paths;
}
export async function startInferenceFixture() {
  const requests = [];
  /** Optional per-request script: return `{ toolCall: { id, name, arguments } }` or null (default reply). */
  let responder = null;
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Control-plane unavailable in deterministic fixture" }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${SENTINEL_KEY}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requests.push({ model: input.model, stream: Boolean(input.stream) });
    const scripted = responder?.(input) ?? null;
    const toolCall = scripted?.toolCall ?? null;
    const message = scripted?.content ?? "AceVra fixture inference complete.";
    const wireToolCall = toolCall && {
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
    };
    const base = {
      id: "fixture-completion",
      object: "chat.completion",
      created: 1,
      model: input.model,
    };
    if (!input.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...base,
          choices: [
            toolCall
              ? {
                  index: 0,
                  message: { role: "assistant", content: null, tool_calls: [wireToolCall] },
                  finish_reason: "tool_calls",
                }
              : {
                  index: 0,
                  message: { role: "assistant", content: message },
                  finish_reason: "stop",
                },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of [
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: toolCall
              ? { role: "assistant", tool_calls: [{ index: 0, ...wireToolCall }] }
              : { role: "assistant", content: message },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      },
    ])
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    setResponder: (next) => {
      responder = next;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
