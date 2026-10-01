import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_WORKER_PORT, type SshComputerConfig } from "@zcode/shared";

const MAX_COMPUTERS = 16;
/** ssh host alias or user@host; no spaces, no option injection (never starts with "-"). */
const HOST_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/;

export function isValidHostAlias(value: string): boolean {
  return HOST_ALIAS.test(value);
}

export function isValidWorkerPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function sanitize(raw: unknown): SshComputerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, hostAlias, workerPort } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
  if (typeof hostAlias !== "string" || !isValidHostAlias(hostAlias)) return null;
  const port = typeof workerPort === "number" ? workerPort : DEFAULT_WORKER_PORT;
  if (!isValidWorkerPort(port)) return null;
  const displayName =
    typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : hostAlias;
  return { id, name: displayName, hostAlias, workerPort: port };
}

/** The SSH computer list (single owner). Local JSON only: never a token or key. */
export function createSshComputersStore(filePath: string) {
  let cache: SshComputerConfig[] | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function load(): Promise<SshComputerConfig[]> {
    if (cache) return cache;
    const raw = await readFile(filePath, "utf8").catch(() => "");
    let parsed: unknown = [];
    try {
      parsed = raw ? (JSON.parse(raw) as { computers?: unknown }).computers : [];
    } catch {
      parsed = [];
    }
    cache = (Array.isArray(parsed) ? parsed : [])
      .map(sanitize)
      .filter((c): c is SshComputerConfig => c !== null)
      .slice(0, MAX_COMPUTERS);
    return cache;
  }

  function persist(next: SshComputerConfig[]): Promise<void> {
    cache = next;
    writing = writing.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, computers: next }, null, 2), "utf8");
      await rename(tmp, filePath);
    });
    return writing;
  }

  return {
    list: load,
    async get(id: string): Promise<SshComputerConfig | null> {
      return (await load()).find((c) => c.id === id) ?? null;
    },
    async add(input: Omit<SshComputerConfig, "id">): Promise<SshComputerConfig[] | null> {
      const entry = sanitize({ ...input, id: randomUUID() });
      const current = await load();
      if (!entry || current.length >= MAX_COMPUTERS) return null;
      const next = [...current, entry];
      await persist(next);
      return next;
    },
    async remove(id: string): Promise<SshComputerConfig[]> {
      const next = (await load()).filter((c) => c.id !== id);
      await persist(next);
      return next;
    },
  };
}
export type SshComputersStore = ReturnType<typeof createSshComputersStore>;
