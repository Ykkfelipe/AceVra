import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CuaHelperError } from "./broker.js";
import {
  buildHostConnectOpenArgs,
  createCuaBrokerHost,
  readDesignatedRequirement,
} from "./host-transport.js";

export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";
const CANONICAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";
const LEGACY_CUA_PLUGIN_ID = "zcode-cua@zcode-plugins-official";
const UNAVAILABLE = "Computer Use is not available in this build.";
const unavailableReject = () => Promise.reject(new CuaHelperError(UNAVAILABLE));

function readPluginConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const plugins = parsed.plugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return {};
    return plugins;
  } catch {
    return {};
  }
}

function readCuaPluginState(config) {
  const enabledPlugins =
    config.enabledPlugins && typeof config.enabledPlugins === "object" ? config.enabledPlugins : {};
  const suppressedBuiltins = Array.isArray(config.suppressedBuiltins)
    ? config.suppressedBuiltins
    : [];
  const enabled =
    enabledPlugins[CANONICAL_CUA_PLUGIN_ID] ?? enabledPlugins[LEGACY_CUA_PLUGIN_ID] ?? false;
  return {
    enabled: enabled === true,
    explicit:
      Object.hasOwn(enabledPlugins, CANONICAL_CUA_PLUGIN_ID) ||
      Object.hasOwn(enabledPlugins, LEGACY_CUA_PLUGIN_ID),
    suppressed:
      suppressedBuiltins.includes(CANONICAL_CUA_PLUGIN_ID) ||
      suppressedBuiltins.includes(LEGACY_CUA_PLUGIN_ID),
  };
}

function resolveCuaPluginState(options) {
  const env = options.env ?? process.env;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const zcodeHome = env.ZCODE_HOME?.trim() || join(home, ".zcode");
  const user = readCuaPluginState(readPluginConfig(join(zcodeHome, "cli", "config.json")));
  if (!options.workingDirectory) return user;
  const workspaceRoot = resolve(options.workingDirectory);
  const workspaceFromRoot = readCuaPluginState(readPluginConfig(join(workspaceRoot, "zcode.json")));
  const workspaceFromZcodeDir = readCuaPluginState(
    readPluginConfig(join(workspaceRoot, ".zcode", "config.json")),
  );
  const workspace = workspaceFromZcodeDir.explicit ? workspaceFromZcodeDir : workspaceFromRoot;
  return {
    enabled: workspace.explicit ? workspace.enabled : user.enabled,
    suppressed: workspace.suppressed || workspaceFromRoot.suppressed || user.suppressed,
  };
}

export async function waitForProductHelperAdmission(transport, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!transport?.helperConnected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!transport?.helperConnected) {
    throw new CuaHelperError("AceVra Computer Use Helper admission timed out", {
      code: "helper_admission_timeout",
    });
  }
  return transport;
}

export async function queryProductHelperPermissionStatus(transport) {
  if (!transport?.helperConnected) throw new CuaHelperError(UNAVAILABLE);
  return await transport.callMethod("permission_status", undefined, { timeoutMs: 3_000 });
}

export function buildHelperOpenArgs(spec, launcherPid) {
  if (!spec || typeof spec.appPath !== "string") return [];
  return [
    "-a",
    spec.appPath,
    "--args",
    ...(spec.args ?? []),
    ...(launcherPid ? [`--launcher-pid=${launcherPid}`] : []),
  ];
}
export async function resolveHelperPermissionSubjectIdentity(appPath) {
  if (typeof appPath !== "string" || !appPath.trim()) throw new CuaHelperError(UNAVAILABLE);
  return {
    appPath,
    executablePath: `${appPath}/Contents/MacOS/AceVraComputerUse`,
    displayName: "AceVra Computer Use",
    bundleId: "dev.acevra.cua-helper",
  };
}
export function isCuaLocalDevelopmentRuntime(_env, compiledLocalDevelopmentRuntime) {
  return compiledLocalDevelopmentRuntime === true;
}
export function createCuaHelperInstaller(options = {}) {
  const appPath = typeof options.bundledAppPath === "string" ? options.bundledAppPath.trim() : "";
  if (!appPath) return { ensureInstalled: unavailableReject, verifyInstalled: unavailableReject };
  return {
    ensureInstalled: async () => appPath,
    verifyInstalled: async (candidate) => {
      if (candidate !== appPath)
        throw new CuaHelperError("packaged Computer Use Helper is missing", {
          code: "helper_missing",
        });
    },
  };
}
export const defaultCuaHelperVerifierDependencies = {
  readExecutableArchs: unavailableReject,
  verifyCodeSignature: unavailableReject,
  verifyTeamIdentifier: unavailableReject,
};
export function cuaBrokerRefreshMarkerPath(_socketPath) {
  return undefined;
}
export async function publishCuaBrokerRefreshMarker(_socketPath, _options) {
  return { path: undefined };
}
export function loadRealNativeAddon(_options) {
  throw new CuaHelperError(UNAVAILABLE);
}
export function resolvePackagedNativeAddonPath(_options) {
  throw new CuaHelperError(UNAVAILABLE);
}
export function resolveInTreeAddonPath(_options) {
  throw new CuaHelperError(UNAVAILABLE);
}
export function createAxReadOnlyMethods(_source, _registry, _options) {
  return {};
}
export const ROLE_TO_KIND = {};
export function roleToKind(_role) {
  throw new CuaHelperError(UNAVAILABLE);
}
export class CuaHelperLifecycleManager {
  #dispose;
  #current;
  #disposed = false;
  constructor(dispose) {
    this.#dispose = dispose;
  }
  async acquire(options) {
    if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) return undefined;
    const managed = options?.create?.();
    this.#current = managed;
    return managed;
  }
  peek() {
    return this.#current;
  }
  get disposed() {
    return this.#disposed;
  }
  async dispose(managed) {
    this.#disposed = true;
    await this.#dispose?.(managed ?? this.#current);
  }
}
export class CuaProductHelperWorkspaceRegistry {
  setEnabled(_context, _enabled) {}
}
/**
 * One transport hand-out from the managed product host.
 *
 * The socket, the config-provenance authority and the per-launch session capability must travel
 * together: the hardened relay refuses every client request whose `request.token` does not match the
 * launch token this very transport minted, so a tuple without the capability is unusable rather than
 * merely weaker. Every field is read from the same live transport object in one expression, so parts
 * cannot be mixed across transport generations.
 *
 * Exported so the managed-path regression can assert the real shape instead of a hand-built stub.
 */
export function buildProductCuaTransportTuple(live) {
  return {
    socketPath: live.socketPath,
    pluginAuthority: "packaged-cua",
    sessionCapabilityRequired: true,
    sessionCapabilityToken: live.token,
  };
}

export function createProductCuaHelperHost(options = {}) {
  const appPath =
    typeof options.bundledHelperAppPath === "string" ? options.bundledHelperAppPath.trim() : "";
  if (!appPath) return createUnavailableCuaHelperHost();
  let transport = null;
  let startup = null;
  const transportTuple = buildProductCuaTransportTuple;
  const start = async () => {
    if (transport) {
      await waitForProductHelperAdmission(transport);
      return transportTuple(transport);
    }
    startup ??= (async () => {
      const env = options.env ?? process.env;
      const runTool = async (command, args) => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        return promisify(execFile)(command, args, { encoding: "utf8" });
      };
      const peerProbePath = options.peerProbePath ?? env.ZCODE_CUA_PEER_IDENTITY_PROBE;
      const helperRequirement = await readDesignatedRequirement(appPath, runTool);
      const hostRequirement = await readDesignatedRequirement(process.execPath, runTool);
      const peerProbeRequirement = peerProbePath
        ? await readDesignatedRequirement(peerProbePath, runTool)
        : null;
      if (!helperRequirement || !hostRequirement || !peerProbePath || !peerProbeRequirement) {
        throw new CuaHelperError(
          "packaged Helper, peer probe, or designated requirement is unavailable",
          { code: "helper_identity_unavailable" },
        );
      }
      const next = createCuaBrokerHost({
        env,
        expectedHelperIdentifiers: ["dev.acevra.cua-helper"],
        launchContract: {
          hostRequirement,
          helperRequirement,
          observationDir: `${env.ZCODE_HOME ?? ""}/computer-use/observations`,
          idleMs: 15_000,
        },
        peerProbePath,
        peerProbeRequirement,
      });
      await next.start();
      transport = next;
      try {
        await runTool(
          "/usr/bin/open",
          buildHostConnectOpenArgs({
            appPath,
            socketPath: next.socketPath,
            launchToken: next.token,
            hostRequirement,
            helperRequirement,
            observationDir: `${env.ZCODE_HOME ?? ""}/computer-use/observations`,
            idleMs: 15_000,
          }),
        );
        await waitForProductHelperAdmission(next);
      } catch (error) {
        await next.stop();
        transport = null;
        throw error;
      }
      return transportTuple(next);
    })().catch((error) => {
      startup = null;
      throw error;
    });
    return startup;
  };
  const stop = async () => {
    await transport?.stop();
    transport = null;
    startup = null;
  };
  const restart = async () => {
    await stop();
    return start();
  };
  return {
    get running() {
      return Boolean(transport?.helperConnected);
    },
    get socketPath() {
      return transport?.socketPath ?? null;
    },
    get pluginAuthority() {
      return transport ? "packaged-cua" : null;
    },
    get reservedTransport() {
      return transport ? transportTuple(transport) : undefined;
    },
    start,
    stop,
    restart,
    restartAfterCurrentStart: restart,
    restartAfterCurrentStartPreservingTransport: async () => ({
      handle: await start(),
      reused: false,
    }),
    waitForTransport: start,
    checkHealth: async () => ({
      bundleId: "dev.acevra.cua-helper",
      pid: transport?.admittedHelper?.pid ?? null,
      verified: true,
    }),
    releaseControl: async (params) => {
      if (!transport) throw new CuaHelperError(UNAVAILABLE);
      return await transport.callMethod("release_control", params, { timeoutMs: 2_000 });
    },
    // CUA-4：与 releaseControl 同一条已验证传输上的只读查询；不改租约状态，超时有上限。
    queryControlStatus: async (params) => {
      if (!transport) throw new CuaHelperError(UNAVAILABLE);
      return await transport.callMethod("control_status", params, { timeoutMs: 2_000 });
    },
    queryScreenCaptureProbe: async () => ({ ok: false, reason: UNAVAILABLE }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: async () => await queryProductHelperPermissionStatus(transport),
  };
}
function createUnavailableCuaHelperHost() {
  return {
    get running() {
      return false;
    },
    get socketPath() {
      return null;
    },
    get pluginAuthority() {
      return null;
    },
    get reservedTransport() {
      return undefined;
    },
    start: unavailableReject,
    stop: async () => {},
    restart: unavailableReject,
    restartAfterCurrentStart: unavailableReject,
    waitForTransport: unavailableReject,
    checkHealth: unavailableReject,
    releaseControl: unavailableReject,
    queryControlStatus: unavailableReject,
    queryScreenCaptureProbe: async () => ({ ok: false, reason: UNAVAILABLE }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: unavailableReject,
  };
}
export function isOfficialCuaPluginEnabledForWorkspace(options = {}) {
  const state = resolveCuaPluginState(options);
  return state.enabled && !state.suppressed;
}
export function createCuaProductMcpServerResolver(host, _options) {
  return {
    resolveMcpServers: async (servers) => servers,
    restart: () => host.restart(),
    restartAfterPermissionGrant: () => host.restart(),
  };
}
export async function waitForCuaHelperStartup(startup) {
  return await startup;
}
export function isPotentialZCodeCuaAgentMcpServer(_server) {
  return false;
}
export function isScreenCaptureProbeSuccess(_probe) {
  return false;
}
export function markCuaProductHelperAgentEnvUnavailable(_host) {}
export function hasCuaProductHelperAgentEnvUnavailable(_host) {
  return false;
}
export function clearCuaProductHelperAgentEnvUnavailable(_host) {}
export async function reapOrphanedHelpers(_options) {}
export async function requestHelperAccessibilityPermissionViaLaunchServices(_options) {
  return { ok: false, reason: UNAVAILABLE };
}
export async function requestHelperScreenRecordingPermissionViaLaunchServices(_options) {
  return { ok: false, reason: UNAVAILABLE };
}
