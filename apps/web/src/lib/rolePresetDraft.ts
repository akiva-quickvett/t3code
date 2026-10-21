import { rolePresetDraftChoice } from "@t3tools/client-runtime/state/agent-roles";
import type { EffectiveAgentRolePreset } from "@t3tools/contracts";

import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";

/** A new thread takes the role's model and modes; clearing the role keeps them. */
export function applyRolePresetToDraft(
  target: ComposerThreadTarget,
  preset: EffectiveAgentRolePreset | null,
): void {
  const store = useComposerDraftStore.getState();
  const choice = preset === null ? null : rolePresetDraftChoice(preset);
  store.setDraftThreadContext(target, {
    rolePreset: choice?.rolePreset ?? null,
    ...(choice?.runtimeMode === undefined ? {} : { runtimeMode: choice.runtimeMode }),
    ...(choice?.interactionMode === undefined ? {} : { interactionMode: choice.interactionMode }),
  });
  if (choice?.modelSelection !== undefined) {
    store.setModelSelection(target, choice.modelSelection, {
      explicit: true,
      replaceOptions: true,
    });
  }
  if (choice?.runtimeMode !== undefined) store.setRuntimeMode(target, choice.runtimeMode);
  if (choice?.interactionMode !== undefined) {
    store.setInteractionMode(target, choice.interactionMode);
  }
}
