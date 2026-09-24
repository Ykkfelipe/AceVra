import { CuaHelperError } from "./broker.js";
import {
  buildHostConnectOpenArgs,
  createCuaBrokerHost,
  readDesignatedRequirement,
} from "./host-transport.js";

export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";
const UNAVAILABLE = "Computer Use is not available in this build.";
const unavailableReject = () => Promise.reject(new CuaHelperError(UNAVAILABLE));

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
export function createProductCuaHelperHost(options = {}) {
  const appPath =
    typeof options.bundledHelperAppPath === "string" ? options.bundledHelperAppPath.trim() : "";
  if (!appPath) return createUnavailableCuaHelperHost();
  let transport = null;
  let startup = null;
  const start = async () => {
    if (transport) return { socketPath: transport.socketPath, pluginAuthority: "packaged-cua" };
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
      transport = next;
      return { socketPath: next.socketPath, pluginAuthority: "packaged-cua" };
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
      return transport
        ? { socketPath: transport.socketPath, pluginAuthority: "packaged-cua" }
        : undefined;
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
    queryScreenCaptureProbe: async () => ({ ok: false, reason: UNAVAILABLE }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: async () => ({}),
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
    queryScreenCaptureProbe: async () => ({ ok: false, reason: UNAVAILABLE }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: async () => ({}),
  };
}
export function isOfficialCuaPluginEnabledForWorkspace(_options) {
  return false;
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
