import type { AgentRolePreset } from "@t3tools/contracts";
import type { ProviderAdapterV2Role } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Hash from "effect/Hash";

export const ROLE_CLEARED_NOTE =
  "The role instructions given earlier in this conversation no longer apply.";

export function adapterRole(preset: AgentRolePreset): ProviderAdapterV2Role {
  return {
    presetId: preset.id,
    label: preset.label,
    instructions: preset.instructions,
    ...(preset.skills === undefined ? {} : { skills: preset.skills }),
    ...(preset.allowedChildRoles === undefined
      ? {}
      : { allowedChildRoles: preset.allowedChildRoles }),
    ...(preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow }),
  };
}

/**
 * Everything the agent is told about its role, wrapped so the model cannot
 * mistake it for text the user wrote. Empty when the role says nothing.
 */
export function roleInstructionsBlock(role: ProviderAdapterV2Role): string {
  const body = [
    role.instructions,
    role.skills?.length ? `Skills for this role: ${role.skills.join(", ")}.` : "",
    role.allowedChildRoles?.length
      ? `Roles you may delegate to: ${role.allowedChildRoles.join(", ")}.`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return body === ""
    ? ""
    : `<t3_role_instructions role="${role.presetId}">\n${body}\n</t3_role_instructions>`;
}

/**
 * For providers that take the role in the prompt: what to prefix to this turn,
 * given what the provider thread was last told. The role goes out on the first
 * turn, again when it changes, and a cleared role is retracted once.
 */
export function rolePromptNote(input: {
  readonly role: ProviderAdapterV2Role | undefined;
  readonly deliveredKey: string | undefined;
}): { readonly note: string; readonly key: string | undefined } {
  const block = input.role === undefined ? "" : roleInstructionsBlock(input.role);
  const key = block === "" ? undefined : String(Hash.string(block));
  if (key === input.deliveredKey) return { note: "", key };
  return { note: block === "" ? ROLE_CLEARED_NOTE : block, key };
}
