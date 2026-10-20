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
    ...(preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow }),
  };
}

/** Wrapped so the model cannot mistake the role for text the user wrote. */
export function roleInstructionsBlock(role: ProviderAdapterV2Role): string {
  return `<t3_role_instructions role="${role.presetId}">\n${role.instructions}\n</t3_role_instructions>`;
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
  const role = input.role?.instructions === "" ? undefined : input.role;
  const key = role === undefined ? undefined : `${role.presetId}:${Hash.string(role.instructions)}`;
  if (key === input.deliveredKey) return { note: "", key };
  if (role !== undefined) return { note: roleInstructionsBlock(role), key };
  return { note: ROLE_CLEARED_NOTE, key };
}
