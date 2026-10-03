/**
 * Bot 身份与档案：纯函数，无 IO。
 *
 * 身份（identity）与对话状态严格分离：对话的新建/清空不得改动这里的事实，
 * 编辑档案也不得触碰 memory / conversation 文档。
 */

export interface BotAvatar {
  /** initial = 用字形回退渲染；image = value 指向已落地的头像资源标识。 */
  kind: "initial" | "image";
  /** image 时为资源标识；initial 时缺省由 displayName 派生。 */
  value: string | null;
}

export type BotTone = "warm" | "neutral" | "direct" | "playful";

export type BotVerbosity = "concise" | "balanced" | "detailed";

/**
 * 强调色只允许命名预设，不允许任意色值：UI 侧必须落在 DESIGN.md 的语义 token 上，
 * 避免 Bot 自定制（后续里程碑）绕过设计系统直接写死颜色。
 */
export type BotAccent = "default" | "violet" | "blue" | "teal" | "amber";

export interface BotStyle {
  tone: BotTone;
  verbosity: BotVerbosity;
  accent: BotAccent;
}

/** 稳定身份：与任何 conversation / session 无关，创建后不再变化（除 updatedAt）。 */
export interface BotIdentity {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface BotProfile {
  displayName: string;
  /** 一句话描述，展示在 Bot 名称下方。 */
  descriptor: string;
  avatar: BotAvatar;
  style: BotStyle;
  updatedAt: number;
}

export interface BotProfilePatch {
  displayName?: string;
  descriptor?: string;
  avatar?: BotAvatar;
  style?: Partial<BotStyle>;
}

export const DEFAULT_BOT_DISPLAY_NAME = "Ace";

export const DEFAULT_BOT_DESCRIPTOR = "Personal assistant";

export const DEFAULT_BOT_STYLE: BotStyle = {
  tone: "warm",
  verbosity: "balanced",
  accent: "default",
};

export const MAX_BOT_DISPLAY_NAME_LENGTH = 48;

export const MAX_BOT_DESCRIPTOR_LENGTH = 96;

const TONES: readonly BotTone[] = ["warm", "neutral", "direct", "playful"];

const VERBOSITIES: readonly BotVerbosity[] = ["concise", "balanced", "detailed"];

const ACCENTS: readonly BotAccent[] = ["default", "violet", "blue", "teal", "amber"];

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function clampText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

export function createDefaultBotIdentity(now: number, id: string): BotIdentity {
  return { id, createdAt: now, updatedAt: now };
}

export function createDefaultBotProfile(now: number): BotProfile {
  return {
    displayName: DEFAULT_BOT_DISPLAY_NAME,
    descriptor: DEFAULT_BOT_DESCRIPTOR,
    avatar: { kind: "initial", value: null },
    style: { ...DEFAULT_BOT_STYLE },
    updatedAt: now,
  };
}

/**
 * 读取持久化档案时归一化：旧版本或缺省字段回退到默认值，
 * 未知枚举值丢弃而不是让整个文档读取失败。
 */
export function normalizeBotProfile(input: unknown, now: number): BotProfile {
  const fallback = createDefaultBotProfile(now);
  if (!input || typeof input !== "object") return fallback;
  const candidate = input as Partial<BotProfile>;

  const displayName = clampText(candidate.displayName, MAX_BOT_DISPLAY_NAME_LENGTH);
  const descriptor = clampText(candidate.descriptor, MAX_BOT_DESCRIPTOR_LENGTH);
  const avatar = candidate.avatar;
  const style = (candidate.style ?? {}) as Partial<BotStyle>;

  return {
    displayName: displayName ?? fallback.displayName,
    descriptor: descriptor ?? fallback.descriptor,
    avatar:
      avatar && (avatar.kind === "initial" || avatar.kind === "image")
        ? {
            kind: avatar.kind,
            value:
              typeof avatar.value === "string" && avatar.value.length > 0 ? avatar.value : null,
          }
        : fallback.avatar,
    style: {
      tone: isOneOf(style.tone, TONES) ? style.tone : fallback.style.tone,
      verbosity: isOneOf(style.verbosity, VERBOSITIES) ? style.verbosity : fallback.style.verbosity,
      accent: isOneOf(style.accent, ACCENTS) ? style.accent : fallback.style.accent,
    },
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : now,
  };
}

/** 档案补丁只改显式给出的字段；空字符串视为“不改”而不是“清空”。 */
export function applyBotProfilePatch(
  profile: BotProfile,
  patch: BotProfilePatch,
  now: number,
): BotProfile {
  const displayName = clampText(patch.displayName, MAX_BOT_DISPLAY_NAME_LENGTH);
  const descriptor = clampText(patch.descriptor, MAX_BOT_DESCRIPTOR_LENGTH);
  const stylePatch = patch.style ?? {};

  return {
    displayName: displayName ?? profile.displayName,
    descriptor: descriptor ?? profile.descriptor,
    avatar: patch.avatar ?? profile.avatar,
    style: {
      tone: isOneOf(stylePatch.tone, TONES) ? stylePatch.tone : profile.style.tone,
      verbosity: isOneOf(stylePatch.verbosity, VERBOSITIES)
        ? stylePatch.verbosity
        : profile.style.verbosity,
      accent: isOneOf(stylePatch.accent, ACCENTS) ? stylePatch.accent : profile.style.accent,
    },
    updatedAt: now,
  };
}
