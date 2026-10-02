// CUA-1.75 relay framing helpers, split from host-transport.js (single-file size boundary).
// Pure socket/line plumbing plus the relay's structured-failure shapes; no session state here.

/**
 * Newline framing shared by the client and helper roles: complete lines only, oversized lines
 * destroy the socket (after `onOversized`, so the owner can record why the connection ended).
 * `initial` carries bytes already received with the first line.
 */
export function attachLineFraming(socket, initial, maxBytes, onLine, onOversized) {
  let buffer = initial;
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(buffer) > maxBytes) {
          onOversized?.();
          socket.destroy();
        }
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxBytes) {
        onOversized?.();
        socket.destroy();
        return;
      }
      onLine(line);
    }
  });
}

/** Safe relay metadata kept on a failure across layers (never paths or tokens). */
export function relayFailureDetails(error) {
  if (!error || typeof error !== "object") return {};
  return {
    ...(typeof error.delivery === "string" ? { delivery: error.delivery } : {}),
    ...(Number.isInteger(error.connection_generation)
      ? { connection_generation: error.connection_generation }
      : {}),
  };
}

/** Stamp the generation that produced a Helper response (spec "Generation fencing"). */
export function stampConnectionGeneration(response, generation) {
  if (response?.ok === true && response.result && typeof response.result === "object") {
    response.result.connection_generation = generation;
  } else if (response?.error && typeof response.error === "object") {
    response.error.connection_generation = generation;
  }
  return response;
}

/**
 * One stable, path-free refusal on any relay surface (spec: no host paths in public errors).
 * `extra` carries only safe metadata (delivery, layer, connection_generation) so every layer
 * above can keep the original code instead of collapsing it to "(unknown): failed".
 */
export function respondError(context, message, code, extra = {}) {
  context.respond(JSON.stringify({ ok: false, error: { message, code, ...extra } }));
}

/** One stable, path-free hello refusal (spec: no host paths, no token data in errors). */
export function refuseHello(socket, code, message) {
  if (socket.writable) {
    socket.write(`${JSON.stringify({ ok: false, error: { message, code } })}\n`);
  }
  socket.destroy();
}

export class CuaHostTransportError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CuaHostTransportError";
    this.code = options.code ?? "unavailable";
    if (options.details && Object.keys(options.details).length > 0) this.details = options.details;
  }
}

/** A refusal that provably never reached the Helper: safe to retry in a later generation. */
export function notSentDetails(connectionGeneration) {
  return { delivery: "not_sent", layer: "host_relay", connection_generation: connectionGeneration };
}
