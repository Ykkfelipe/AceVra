// 回归：Cross-Mode × Multitask 集成时 Desktop agent 打包失败——`@zcode/shared/cross-mode`
// 被通用 "@zcode/shared" 前缀 alias 改写成 `src/index.ts/cross-mode`（esbuild alias 按前缀改写）。
// cross-mode 分支新增了 shared 导出，Multitask 采纳层（core/src/cross-mode）首次在 CLI 打包闭包里
// import 它；两边单独都不失败，只有合在一起才出现。build.mjs 里同类注释已记录过五次。
// 本测试把「CLI 打包闭包里 import 的每个 shared 子路径都必须有精确 alias，且指向 shared exports
// 声明的同一文件」钉成不变式：新增子路径时在这里失败，而不是在 Desktop agent 打包时失败。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveBuildAliases } from "../scripts/build.mjs";

const sharedRoot = resolve(import.meta.dirname, "../../../../../packages/shared");
const cliPackagesRoot = resolve(import.meta.dirname, "../..");

async function hasOwnBundler(packageRoot) {
  try {
    await readFile(join(packageRoot, "scripts/build.mjs"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** CLI 打包闭包里各包源码实际 import 的 shared 子路径（只看 src，不看测试与产物）。 */
async function importedSharedSubpaths() {
  const found = new Set();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) {
        const text = await readFile(path, "utf8");
        for (const match of text.matchAll(/["']@zcode\/shared\/([\w./-]+)["']/g)) found.add(match[1]);
      }
    }
  };
  for (const entry of await readdir(cliPackagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // 自带打包脚本的包（例如独立进程 node-repl-host）不走本 alias 表，按它自己的构建解析。
    if (entry.name !== "cli" && (await hasOwnBundler(join(cliPackagesRoot, entry.name)))) continue;
    const source = join(cliPackagesRoot, entry.name, "src");
    try {
      await walk(source);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return [...found].sort();
}

test("every @zcode/shared subpath imported by CLI sources has an exact alias to its exported file", async () => {
  const manifest = JSON.parse(await readFile(resolve(sharedRoot, "package.json"), "utf8"));
  const aliases = resolveBuildAliases();
  const imported = await importedSharedSubpaths();
  assert.ok(imported.includes("cross-mode"), "the Multitask adoption imports the cross-mode contract");
  const problems = [];
  for (const subpath of imported) {
    const specifier = `@zcode/shared/${subpath}`;
    const target = manifest.exports[`./${subpath}`];
    if (target === undefined) problems.push(`${specifier}: not exported by @zcode/shared`);
    else if (!(specifier in aliases))
      problems.push(`${specifier}: no exact alias (would become src/index.ts/${subpath})`);
    else if (aliases[specifier] !== resolve(sharedRoot, target))
      problems.push(`${specifier}: alias ${aliases[specifier]} != export ${target}`);
  }
  assert.deepEqual(problems, []);
});

test("the cross-mode contract resolves to its single canonical module", () => {
  assert.equal(
    resolveBuildAliases()["@zcode/shared/cross-mode"],
    resolve(sharedRoot, "src/cross-mode/index.ts"),
  );
});
