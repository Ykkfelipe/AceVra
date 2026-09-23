/**
 * The model-facing boundary for Computer Use observation results.
 *
 * The helper is the only component that can bound what it *reads* (see `ObservationLimits` in
 * `native/cua-helper/Observe.swift`); this module is the only component that can bound what a
 * *model* ends up seeing. Both exist on purpose, because the helper's socket is a host-internal
 * channel while everything below is what leaves the host:
 *
 *   helper socket result  ->  sanitizeObservationResult  ->  node_repl CUA bridge  ->  model
 *
 * Two rules are enforced here, and neither is a formatting preference:
 *
 *  1. **No host filesystem path.** `observe` writes its PNG into the helper's runtime directory
 *     and returns that path, which is right for a host-internal channel — but a filesystem path
 *     handed to a model is both useless (the model cannot read it) and a disclosure of the
 *     user's directory layout. The path is replaced by the opaque `observation_id` the helper
 *     already returns, so a future artifact bridge can still fetch the bytes by id.
 *
 *  2. **Bounded.** Element counts, per-string lengths, action lists and the total serialized size
 *     are capped again here. A helper that is buggy, replaced, or simply observing a pathological
 *     app must not be able to hand the model an unbounded dump.
 *
 * Sanitizing is deliberately lossless about *facts*: dimensions, pixel statistics, `blank`, the
 * `effect`/`route`/`evidence` envelope and every AX field the model reasons about all survive.
 * Only disclosure and size are constrained.
 */

/** Ceilings applied to an observation result on its way to a model. */
export const OBSERVE_LIMITS = Object.freeze({
  /** Mirrors ObservationLimits.maxElementsCeiling in the helper. */
  maxElements: 2000,
  /** Mirrors ObservationLimits.maxStringCharacters in the helper. */
  maxStringCharacters: 512,
  /** Mirrors ObservationLimits.maxActionsPerElement in the helper. */
  maxActionsPerElement: 32,
  /** Ceiling for `list_windows`. */
  maxWindows: 500,
  /**
   * Total serialized size one observation may hand back. The node_repl bridge caps a response at
   * 32 MiB, which is a transport limit and not a context budget; this is far below it so a
   * pathological tree is trimmed here rather than by the transport.
   */
  maxResultBytes: 512 * 1024,
});

/**
 * Keys whose value is a host filesystem location. Dropped rather than renamed: a key still called
 * `path` invites a later reader to trust it.
 */
const HOST_PATH_KEYS = new Set([
  "path",
  "paths",
  "hostPath",
  "host_path",
  "absolutePath",
  "absolute_path",
  "filePath",
  "file_path",
  "directory",
  "dir",
]);

/**
 * Absolute host locations, anchored at the roots this runtime writes to plus the conventional
 * user and system roots. Deliberately conservative: matching `/` in general would mangle ordinary
 * UI text ("Settings/General") while protecting nothing.
 */
const HOST_PATH_PATTERN =
  /(?:\/(?:Users|private|var|tmp|Volumes|Applications|System|Library|opt|etc)\/|\/home\/)[^\s"'`,;)\]]*/g;

const REDACTED_PATH = "<redacted-host-path>";

/**
 * Replace absolute host locations inside free text.
 *
 * Exported because the runtime also has to redact text it produces itself: a broker failure message
 * embeds the socket path, and that failure path is the ordinary first-use case (no Helper running
 * yet), so it would otherwise be the one unsanitized string a model sees.
 */
export function redactHostPaths(text) {
  if (typeof text !== "string") return text;
  return text.replace(HOST_PATH_PATTERN, REDACTED_PATH);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundString(value, max, stats) {
  let text = value;
  if (text.length > max) {
    stats.stringsTruncated += 1;
    text = `${text.slice(0, max)}…`;
  }
  const redacted = redactHostPaths(text);
  if (redacted !== text) stats.pathsRedacted += 1;
  return redacted;
}

/** Structural copy with path keys dropped and text bounded. Arrays keep their order. */
function visit(node, stats) {
  if (Array.isArray(node)) return node.map((item) => visit(item, stats));
  if (!isPlainObject(node)) {
    return typeof node === "string"
      ? boundString(node, OBSERVE_LIMITS.maxStringCharacters * 8, stats)
      : node;
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (HOST_PATH_KEYS.has(key)) {
      stats.pathKeysDropped.add(key);
      continue;
    }
    if (typeof value === "string") {
      out[key] = boundString(value, OBSERVE_LIMITS.maxStringCharacters, stats);
    } else if (isPlainObject(value) || Array.isArray(value)) {
      out[key] = visit(value, stats);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundElements(elements, stats) {
  const bounded = elements.map((element) => {
    if (!isPlainObject(element)) return element;
    const copy = { ...element };
    for (const key of ["role", "label", "value", "identifier"]) {
      if (typeof copy[key] === "string" && copy[key].length > OBSERVE_LIMITS.maxStringCharacters) {
        copy[key] = `${copy[key].slice(0, OBSERVE_LIMITS.maxStringCharacters)}…`;
        stats.stringsTruncated += 1;
      }
    }
    if (Array.isArray(copy.actions) && copy.actions.length > OBSERVE_LIMITS.maxActionsPerElement) {
      copy.actions = copy.actions.slice(0, OBSERVE_LIMITS.maxActionsPerElement);
    }
    return copy;
  });
  if (bounded.length <= OBSERVE_LIMITS.maxElements) return { elements: bounded, dropped: 0 };
  return {
    elements: bounded.slice(0, OBSERVE_LIMITS.maxElements),
    dropped: bounded.length - OBSERVE_LIMITS.maxElements,
  };
}

/**
 * Shrink one array-valued field until the whole payload fits, halving the kept count. Halving is
 * what makes this terminate: every pass either fits or strictly reduces `kept`, and `kept` reaches
 * 0. Returns the number of entries dropped.
 */
function shrinkArrayToBudget(payload, key) {
  const source = payload[key];
  if (!Array.isArray(source) || source.length === 0) return 0;
  const total = source.length;
  let kept = total;
  while (
    kept > 0 &&
    serializedBytes({ ...payload, [key]: source.slice(0, kept) }) > OBSERVE_LIMITS.maxResultBytes
  ) {
    kept = Math.floor(kept / 2);
  }
  payload[key] = source.slice(0, kept);
  return total - kept;
}

/**
 * Enforce the total serialized budget.
 *
 * This is deliberately not tree-specific: `list_windows`, `list_apps`, `evidence` and a tree are all
 * arrays a helper can make large, and the budget has to hold whichever one dominates. The ladder
 * shrinks the largest list-shaped fields first, then the tree, and finally falls back to the
 * envelope alone — so the result is bounded for *any* payload shape rather than for the one that
 * happened to be common.
 *
 * Returns the payload to use plus how many entries that cost.
 */
function enforceByteBudget(sanitized, stats, limits) {
  if (serializedBytes(sanitized) <= OBSERVE_LIMITS.maxResultBytes) {
    return { result: sanitized, dropped: 0 };
  }
  limits.exceededBytes = true;
  sanitized.truncated_for_size = true;
  let dropped = 0;
  for (const key of ["windows", "apps", "evidence"]) {
    dropped += shrinkArrayToBudget(sanitized, key);
    if (serializedBytes(sanitized) <= OBSERVE_LIMITS.maxResultBytes) {
      return { result: sanitized, dropped };
    }
  }
  if (isPlainObject(sanitized.tree) && Array.isArray(sanitized.tree.elements)) {
    const total = sanitized.tree.elements.length;
    let kept = total;
    while (
      kept > 0 &&
      serializedBytes({
        ...sanitized,
        tree: { ...sanitized.tree, elements: sanitized.tree.elements.slice(0, kept) },
      }) > OBSERVE_LIMITS.maxResultBytes
    ) {
      kept = Math.floor(kept / 2);
    }
    dropped += total - kept;
    sanitized.tree = {
      ...sanitized.tree,
      elements: sanitized.tree.elements.slice(0, kept),
      truncated: true,
    };
    if (serializedBytes(sanitized) <= OBSERVE_LIMITS.maxResultBytes) {
      return { result: sanitized, dropped };
    }
  }
  // Nothing list-shaped is left to shrink: keep only what identifies the observation. The envelope
  // (`route`, `effect`, `delivery`, `helper_identity`) and the pixel facts are small and are the
  // part a caller can still act on.
  const image = isPlainObject(sanitized.image) ? sanitized.image : undefined;
  return {
    dropped,
    result: {
      pid: sanitized.pid,
      route: sanitized.route,
      delivery: sanitized.delivery,
      effect: sanitized.effect,
      ...(image ? { image } : {}),
      helper_identity: sanitized.helper_identity,
      truncated_for_size: true,
      error: "observation exceeded the client result budget; only the envelope was kept",
    },
  };
}

/**
 * Sanitize one observation result. Returns a new object; the input is never mutated.
 *
 * `redactions` and `limits` are reported for logging and tests; they are not part of the payload.
 */
export function sanitizeObservationResult(result) {
  const stats = { stringsTruncated: 0, pathsRedacted: 0, pathKeysDropped: new Set() };
  const limits = { maxResultBytes: OBSERVE_LIMITS.maxResultBytes, exceededBytes: false };
  if (!isPlainObject(result)) {
    return { result, redactions: { ...stats, pathKeysDropped: [] }, limits };
  }

  let sanitized = visit(result, stats);
  let elementsDropped = 0;

  // The frame's host location becomes an opaque reference. `observation_id` is chosen by the
  // helper and is not derived from the path, so it discloses nothing.
  if (isPlainObject(sanitized.image)) {
    sanitized.image = { ...sanitized.image };
    if (isPlainObject(result.image) && "observation_id" in result.image) {
      sanitized.image.reference = `helper-observation:${String(result.image.observation_id)}`;
    }
    sanitized.image.note =
      "the frame is stored host-side; only its statistics and opaque reference cross the socket";
  }

  if (Array.isArray(sanitized.windows) && sanitized.windows.length > OBSERVE_LIMITS.maxWindows) {
    elementsDropped += sanitized.windows.length - OBSERVE_LIMITS.maxWindows;
    sanitized.windows = sanitized.windows.slice(0, OBSERVE_LIMITS.maxWindows);
    sanitized.truncated = true;
  }

  if (isPlainObject(sanitized.tree) && Array.isArray(sanitized.tree.elements)) {
    const { elements, dropped } = boundElements(sanitized.tree.elements, stats);
    elementsDropped += dropped;
    sanitized.tree = {
      ...sanitized.tree,
      elements,
      truncated: sanitized.tree.truncated === true || dropped > 0,
    };
  }

  const budgeted = enforceByteBudget(sanitized, stats, limits);
  elementsDropped += budgeted.dropped;
  sanitized = budgeted.result;

  return {
    result: sanitized,
    redactions: {
      stringsTruncated: stats.stringsTruncated,
      pathsRedacted: stats.pathsRedacted,
      pathKeysDropped: [...stats.pathKeysDropped],
      elementsDropped,
    },
    limits,
  };
}

/**
 * Whether a sanitized observation result carries anything the shared task-artifact system could
 * treat as a deliverable.
 *
 * CUA-1 returns text only, and this predicate is the test-argued sentinel for that: the artifact
 * registry registers what a producer hands it (`bytes`/`hostPath` plus an origin), so a result with
 * no artifact envelope and no image bytes cannot produce a user-visible artifact even if a bridge
 * were wired to it. Nothing calls it in production — `test/observe-result.test.mjs` asserts it stays
 * false for a realistic `observe` payload, so a future bridge has to change that test on purpose
 * rather than inherit a registration path by accident.
 */
export function hasDeliverablePayload(result) {
  if (!isPlainObject(result)) return false;
  if ("artifactDelivery" in result) return true;
  if (typeof result.image === "string") return true;
  if (isPlainObject(result.image) && typeof result.image.base64 === "string") return true;
  return false;
}
