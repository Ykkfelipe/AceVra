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

  const persist = async (installationId: string): Promise<string> => {
    await mkdir(dirname(filePath), { recursive: true });
    // The temp name must be unique per write, not just per process: two Account windows
    // can each invoke reset concurrently, and sharing one temp path made one rename fail
    // while the other succeeded — leaving the cache and the file holding different ids,
    // which orphans a device row on every launch.
    //
    // A failed rename leaves this scratch file behind. It is deliberately not cleaned
    // up: accountLocalDataGuard.test.ts forbids every removal primitive in this feature,
    // and that blunt invariant is worth more than tidying a rare-path temp file.
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ installationId }), "utf8");
    await rename(temp, filePath);
    return installationId;
  };

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
        return persist(randomUUID());
      })().catch((error) => {
        cached = null;
        throw error;
      });
      return cached;
    },

    /**
     * Mints a fresh identity for this machine and returns it.
     *
     * The installation id is globally unique on the backend and bound to the first
     * account that claims it, so signing in as a different account otherwise fails with
     * `installation_bound` forever — revoking the original device does not help, because
     * the ownership check runs before the revoked check and the row still exists.
     *
     * This is the local escape hatch. It does NOT transfer anything: the new id is a
     * different key, so the previous account keeps its own device row untouched and
     * simply reads as stale. The id remains a non-secret lookup key, never a credential.
     */
    async reset(): Promise<string> {
      const installationId = await persist(randomUUID());
      cached = Promise.resolve(installationId);
      return installationId;
    },
  };
}
