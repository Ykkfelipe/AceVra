/**
 * Bot 能力面：声明式投影，纯函数，无 IO。
 *
 * M1 只声明“Bot 未来可以调用的能力域”，不是工具注册表，也不替代 capability runtime：
 * AceVra 的真实工具与可用性仍由 core 的 canonical capability model 投影（见
 * apps/zcode-cli/packages/core/specs/capability-runtime.md）。这里的事实来源是
 * `executableDomains`——宿主当前真的能把该能力域交给 Bot 执行；没有实现时就不得声称可用。
 */

export const BOT_CAPABILITY_DOMAINS = ["web", "email", "calendar", "files", "devices"] as const;

export type BotCapabilityDomain = (typeof BOT_CAPABILITY_DOMAINS)[number];

export type BotCapabilityAvailability = "available" | "not_configured" | "planned";

export type BotCapabilityAccess = "read" | "read_write";

export interface BotCapabilityEntry {
  domain: BotCapabilityDomain;
  /** 英文规范标签；UI 通过 i18n key（bot.capability.<domain>）本地化，这里是回退值。 */
  label: string;
  availability: BotCapabilityAvailability;
  access: BotCapabilityAccess;
  /** 后果性操作必须先获批；声明在能力面上，后续审批 UI 只读这一处事实。 */
  requiresApproval: boolean;
  summary: string;
}

export interface BotCapabilitySurface {
  entries: BotCapabilityEntry[];
  generatedAt: number;
}

export interface BotCapabilitySurfaceInput {
  /** 宿主当前可执行的能力域。缺省实现的能力域一律不得标记为 available。 */
  executableDomains: readonly BotCapabilityDomain[];
  now: number;
}

interface BotCapabilityDeclaration {
  label: string;
  access: BotCapabilityAccess;
  requiresApproval: boolean;
  summary: string;
  /** 尚无实现时对外呈现的状态：devices 属于规划中，其余属于等待接入。 */
  unimplementedAvailability: Exclude<BotCapabilityAvailability, "available">;
}

const DECLARATIONS: Record<BotCapabilityDomain, BotCapabilityDeclaration> = {
  web: {
    label: "Web",
    access: "read",
    requiresApproval: false,
    summary: "Research and read public web content.",
    unimplementedAvailability: "not_configured",
  },
  email: {
    label: "Email",
    access: "read_write",
    requiresApproval: true,
    summary: "Read and send email; sending always requires approval.",
    unimplementedAvailability: "not_configured",
  },
  calendar: {
    label: "Calendar",
    access: "read_write",
    requiresApproval: true,
    summary: "Read agendas and create or change events with approval.",
    unimplementedAvailability: "not_configured",
  },
  files: {
    label: "Files",
    access: "read_write",
    requiresApproval: true,
    summary: "Work with personal files where permission exists.",
    unimplementedAvailability: "not_configured",
  },
  devices: {
    label: "Devices",
    access: "read_write",
    requiresApproval: true,
    summary: "Use registered machines and devices through AceVra execution targets.",
    unimplementedAvailability: "planned",
  },
};

export function buildBotCapabilitySurface(input: BotCapabilitySurfaceInput): BotCapabilitySurface {
  const executable = new Set(input.executableDomains);
  const entries = BOT_CAPABILITY_DOMAINS.map((domain) => {
    const declaration = DECLARATIONS[domain];
    const availability: BotCapabilityAvailability = executable.has(domain)
      ? "available"
      : declaration.unimplementedAvailability;
    return {
      domain,
      label: declaration.label,
      availability,
      access: declaration.access,
      requiresApproval: declaration.requiresApproval,
      summary: declaration.summary,
    };
  });
  return { entries, generatedAt: input.now };
}
