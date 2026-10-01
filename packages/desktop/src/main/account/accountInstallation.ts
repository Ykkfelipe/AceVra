import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stable, NON-secret identity of this AceVra installation: a random UUID created on first
 * use. Deliberately not derived from hardware, serial, MAC or hostname. It is a lookup key,
 * never a credential; the backend binds it to exactly one account. Survives sign-out.
 */
export function createInstallationStore(filePath: string) {
  let cached: Promise<string> | null = null;
  return {
    getOrCreate(): Promise<string> {
      cached ??= (async () => {
        try {
          const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
            installationId?: unknown;
          };
          if (typeof parsed.installationId === "string" && UUID.test(parsed.installationId)) {
            return parsed.installationId.toLowerCase();
          }
        } catch {
          // Missing or corrupt: mint a new one below.
        }
        const installationId = randomUUID();
        await mkdir(dirname(filePath), { recursive: true });
        const temp = `${filePath}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ installationId }), "utf8");
        await rename(temp, filePath);
        return installationId;
      })().catch((error) => {
        cached = null;
        throw error;
      });
      return cached;
    },
  };
}
