import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const MULTITASK_TOOL_NAME = "Multitask";
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const MultitaskInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(16000),
    sharedContext: z.string().max(16000).optional(),
    workers: z
      .array(
        z
          .object({
            id,
            role: z.string().trim().min(1).max(120),
            profile: z.string().trim().min(1).max(120).optional(),
            model: z.string().trim().min(1).max(200).optional(),
            access: z.enum(["read", "write"]),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    tasks: z
      .array(
        z
          .object({
            id,
            worker: id,
            prompt: z.string().trim().min(1).max(16000),
            dependsOn: z.array(id).max(16).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

export type MultitaskInput = z.infer<typeof MultitaskInputSchema>;
export const MultitaskInputJsonSchema = toToolJsonSchema(MultitaskInputSchema);
// Admission adds only the frozen, generated execution source. Models cannot supply it.
export const MultitaskResolvedInputSchema = MultitaskInputSchema.extend({
  script: z.string(),
  max_concurrency: z.number().int().min(1).max(4),
});
