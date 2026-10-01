import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./ports.js";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies *.sql in name order. Statements are idempotent (IF NOT EXISTS). */
export async function migrate(db: SqlExecutor): Promise<void> {
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.transaction(async (tx) => {
      await tx.exec(await readFile(join(migrationsDir, file), "utf8"));
    });
  }
}
