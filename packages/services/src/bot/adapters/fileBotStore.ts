/**
 * Bot 文档的文件实现：JSON 文件 + 原子写（临时文件 + rename）。
 *
 * 读取语义（与 BotStorePort 契约一致）：
 * - 文件不存在 → null（调用方按默认值创建）；
 * - JSON 解析失败 → BotStoreCorruptError，且**不删除、不覆盖**原文件；
 * - 其他 IO 错误原样抛出，不能被当成“损坏”静默吞掉。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BotStoreCorruptError, type BotStorePort } from "../app/ports.js";

interface FileBotStoreOptions {
  /** Bot 数据根目录；由宿主按数据根解析后注入，测试可指向临时目录。 */
  rootDir: string;
}

interface FileBotStorePaths {
  identity: string;
  conversation: string;
  memory: string;
}

const BOT_STORE_FILE_NAMES = {
  identity: "identity.json",
  conversation: "conversation.json",
  memory: "memory.json",
} as const;

let writeCounter = 0;

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function createFileBotStore(options: FileBotStoreOptions): BotStorePort {
  const paths: FileBotStorePaths = {
    identity: join(options.rootDir, BOT_STORE_FILE_NAMES.identity),
    conversation: join(options.rootDir, BOT_STORE_FILE_NAMES.conversation),
    memory: join(options.rootDir, BOT_STORE_FILE_NAMES.memory),
  };

  async function readDocument(path: string, document: string): Promise<unknown | null> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new BotStoreCorruptError(
        document,
        error instanceof Error ? error.message : "invalid JSON",
      );
    }
  }

  async function writeDocument(path: string, value: unknown): Promise<void> {
    await mkdir(options.rootDir, { recursive: true });
    writeCounter += 1;
    const temporaryPath = `${path}.${process.pid}.${writeCounter}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  return {
    readIdentity: () => readDocument(paths.identity, "identity"),
    writeIdentity: (document) => writeDocument(paths.identity, document),
    readConversation: () => readDocument(paths.conversation, "conversation"),
    writeConversation: (document) => writeDocument(paths.conversation, document),
    readMemory: () => readDocument(paths.memory, "memory"),
    writeMemory: (document) => writeDocument(paths.memory, document),
  };
}
