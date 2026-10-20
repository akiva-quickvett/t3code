import { threadRolePresetOf } from "@t3tools/client-runtime/state/agent-roles";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EffectiveAgentRolePreset,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadRolePreset,
} from "@t3tools/contracts";
import { UserRoundCogIcon } from "lucide-react";
import { type ReactElement, useState } from "react";

import { useEnvironmentSupportsRolePresets, useThreadRoleBadge } from "../../state/agentRoles";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";

const NO_ROLE = "";

interface RolePresetMenuProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly value: ThreadRolePreset | null | undefined;
  readonly onSelect: (preset: EffectiveAgentRolePreset | null) => void;
  readonly trigger: ReactElement;
  readonly disabled?: boolean;
  readonly side?: "top" | "bottom";
}

/** The preset list loads only while the menu is open. */
function RolePresetMenu(props: RolePresetMenuProps) {
  const [open, setOpen] = useState(false);
  const composerLayerProps = useComposerMenuProps();
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger disabled={props.disabled} render={props.trigger} />
      <MenuPopup
        align="start"
        side={props.side ?? "bottom"}
        className="w-72"
        {...(props.side === "top" ? composerLayerProps : {})}
      >
        {open ? <RolePresetMenuItems {...props} /> : null}
      </MenuPopup>
    </Menu>
  );
}

function RolePresetMenuItems(props: RolePresetMenuProps) {
  const query = useEnvironmentQuery(
    serverEnvironment.agentRolePresetsLive({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const presets = query.data?.presets ?? [];
  const removedValue =
    props.value != null && query.data !== null && !presets.some((p) => p.id === props.value?.id)
      ? props.value
      : null;
  return (
    <MenuGroup>
      <MenuGroupLabel>Role</MenuGroupLabel>
      <MenuRadioGroup
        value={props.value?.id ?? NO_ROLE}
        onValueChange={(id) =>
          props.onSelect(id === NO_ROLE ? null : (presets.find((p) => p.id === id) ?? null))
        }
      >
        <MenuRadioItem value={NO_ROLE} closeOnClick>
          No role
        </MenuRadioItem>
        {removedValue ? (
          <MenuRadioItem value={removedValue.id} disabled>
            {removedValue.label} (removed)
          </MenuRadioItem>
        ) : null}
        {presets.map((preset) => (
          <MenuRadioItem key={preset.id} value={preset.id} closeOnClick>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{preset.label}</span>
              <span className="truncate text-muted-foreground text-xs">
                {preset.unavailable?.reason ??
                  preset.resolvedModelSelection?.model ??
                  preset.target.model}
              </span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {query.error ? (
        <p className="px-2 py-1.5 text-destructive-foreground text-xs">{query.error}</p>
      ) : null}
    </MenuGroup>
  );
}

/** For a new thread: picking a role also applies its model and modes. */
export function ComposerRolePicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly value: ThreadRolePreset | null | undefined;
  readonly size: ComposerControlSize;
  readonly disabled?: boolean;
  readonly onSelect: (preset: EffectiveAgentRolePreset | null) => void;
}) {
  const badge = useThreadRoleBadge({
    environmentId: props.environmentId,
    projectId: props.projectId,
    rolePreset: props.value,
  });
  return (
    <RolePresetMenu
      environmentId={props.environmentId}
      projectId={props.projectId}
      value={props.value}
      onSelect={props.onSelect}
      side="top"
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      trigger={
        <ComposerControl size={props.size} aria-label="Role">
          <ComposerControlIcon icon={UserRoundCogIcon} size={props.size} />
          <span data-composer-control-label>{badge?.label ?? "Role"}</span>
          <ComposerControlChevron size={props.size} />
        </ComposerControl>
      }
    />
  );
}

/** For a started thread: sets or clears its role; the model stays as it is. */
export function ThreadHeaderRolePicker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const supported = useEnvironmentSupportsRolePresets(props.environmentId);
  if (!supported || thread === null) return null;
  return (
    <HeaderRolePicker
      environmentId={props.environmentId}
      threadId={props.threadId}
      projectId={thread.projectId}
      rolePreset={thread.rolePreset}
    />
  );
}

function HeaderRolePicker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly rolePreset: ThreadRolePreset | null | undefined;
}) {
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata);
  const badge = useThreadRoleBadge(props);
  return (
    <RolePresetMenu
      environmentId={props.environmentId}
      projectId={props.projectId}
      value={props.rolePreset}
      disabled={!canOperate}
      onSelect={(preset) =>
        void updateMetadata({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            rolePreset: preset === null ? null : threadRolePresetOf(preset),
          },
        })
      }
      trigger={
        <Button
          size="micro"
          variant={badge?.missing ? "warning-outline" : "ghost-muted"}
          aria-label={badge ? `Role: ${badge.label}` : "Set a role"}
        >
          <UserRoundCogIcon aria-hidden />
          {badge === null ? "Role" : badge.missing ? `${badge.label} (removed)` : badge.label}
        </Button>
      }
    />
  );
}
