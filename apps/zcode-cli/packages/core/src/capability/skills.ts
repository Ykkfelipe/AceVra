// Capability ↔ Skill 关系：能力回答"能做什么"，Skill 回答"怎么做好"。
// 本层只给出 Skill 名（来自已发现的 Skill），从不注入 SKILL.md 正文。
import type { Capability, PluginReferenceCatalog, SkillMetadata } from "@zcode/contracts";
import { DOMAIN_SKILL_HINTS } from "./domains.js";

export type CapabilitySkillSource = Pick<
  SkillMetadata,
  "name" | "qualifiedName" | "pluginName" | "pluginId" | "description"
>;

export function skillDisplayName(skill: CapabilitySkillSource): string {
  return skill.qualifiedName ?? skill.name;
}

/** Skill 名（或 qualifiedName 末段）与提示词完全相等才算命中，避免模糊关联。 */
export function skillMatchesHint(skill: CapabilitySkillSource, hint: string): boolean {
  const lowered = hint.toLowerCase();
  const tail = skill.qualifiedName?.split(":").pop()?.toLowerCase();
  return skill.name.toLowerCase() === lowered || tail === lowered;
}

function pluginSkills(
  capability: Capability,
  skills: readonly CapabilitySkillSource[],
  catalog: PluginReferenceCatalog | undefined,
): string[] {
  if (!capability.pluginId) return [];
  const entry = catalog?.plugins.find((plugin) => plugin.pluginId === capability.pluginId);
  const declared = new Set(entry?.skillQualifiedNames ?? []);
  return skills
    .filter((skill) => skill.qualifiedName !== undefined && declared.has(skill.qualifiedName))
    .map(skillDisplayName);
}

function hintedSkills(capability: Capability, skills: readonly CapabilitySkillSource[]): string[] {
  const hints = DOMAIN_SKILL_HINTS[capability.domain] ?? [];
  return skills
    .filter((skill) => hints.some((hint) => skillMatchesHint(skill, hint)))
    .map(skillDisplayName);
}

export function attachRelatedSkills(
  capabilities: readonly Capability[],
  skills: readonly CapabilitySkillSource[],
  catalog: PluginReferenceCatalog | undefined,
): Capability[] {
  return capabilities.map((capability) => {
    const related = [
      ...new Set([
        ...capability.relatedSkills,
        ...pluginSkills(capability, skills, catalog),
        ...hintedSkills(capability, skills),
      ]),
    ].sort();
    return related.length === capability.relatedSkills.length
      ? capability
      : { ...capability, relatedSkills: related };
  });
}
