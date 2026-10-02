// ============================================================
// Capabilities tool - read-only view of what this agent can do right now
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const CAPABILITIES_TOOL_NAME = "Capabilities";

export const CapabilitiesInputSchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe("Only this domain, e.g. 'computer', 'remote_computer', 'mcp', 'browser'."),
    capability: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe("Only this capability id (from a previous Capabilities result or reminder)."),
    includeUnavailable: z
      .boolean()
      .optional()
      .describe("Also list unavailable capabilities with their reasons (default true)."),
  })
  .strict();

export type CapabilitiesInput = z.infer<typeof CapabilitiesInputSchema>;

export const CapabilitiesInputJsonSchema = toToolJsonSchema(CapabilitiesInputSchema);
