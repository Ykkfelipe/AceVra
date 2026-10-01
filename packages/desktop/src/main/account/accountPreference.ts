import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountPreferenceStore } from "./accountSessionController.js";

/** Local "Continue locally" decision. Holds no tokens, identifiers or profile data. */
export function createAccountPreferenceStore(filePath: string): AccountPreferenceStore {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8")) as { choice?: unknown };
        return parsed.choice === "local" ? "local" : "undecided";
      } catch {
        return "undecided";
      }
    },
    async write(choice) {
      await mkdir(dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ choice }), "utf8");
      await rename(temp, filePath);
    },
  };
}
