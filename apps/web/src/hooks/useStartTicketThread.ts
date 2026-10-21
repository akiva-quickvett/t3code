import type { ScopedProjectRef } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { applyRolePresetToDraft } from "../lib/rolePresetDraft";
import { readRolePresets } from "../state/agentRoles";
import { useNewThreadHandler } from "./useHandleNewThread";

const TICKET_ROLE_PRESET_ID = "ticket";

/**
 * Every ticket starts a fresh thread from the ticket role, so each one begins
 * from the same instructions and model; there is no standing ticket thread.
 */
export function useStartTicketThread() {
  const handleNewThread = useNewThreadHandler();
  return async (projectRef: ScopedProjectRef): Promise<void> => {
    const list = await readRolePresets(projectRef.environmentId, projectRef.projectId);
    const preset = list?.presets.find((candidate) => candidate.id === TICKET_ROLE_PRESET_ID);
    if (preset === undefined) {
      toastManager.add({
        type: "error",
        title: "No ticket role",
        description: 'Add a role with the id "ticket" in Settings → Agents.',
      });
      return;
    }
    const opened = await handleNewThread(projectRef);
    if (opened === null) return;
    applyRolePresetToDraft(opened.draftId, preset);
    if (preset.unavailable !== null) {
      toastManager.add({
        type: "warning",
        title: "Ticket started on your current model",
        description: `The ticket role's model can't run here: ${preset.unavailable.reason}`,
      });
    }
  };
}
