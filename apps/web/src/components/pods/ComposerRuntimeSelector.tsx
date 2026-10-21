import type { EnvironmentId, ProjectId, ThreadWorktreeRuntime } from "@t3tools/contracts";
import { BoxIcon, MonitorIcon } from "lucide-react";
import { memo } from "react";

import { useProjectOffersPods } from "../../state/podRuntime";
import { ComposerSelectControl } from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { ComposerContextLabel } from "../ComposerContextLabel";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RUNTIME_ITEMS = [
  { value: "host", label: "Host" },
  { value: "container", label: "Container" },
] as const satisfies ReadonlyArray<{ value: ThreadWorktreeRuntime; label: string }>;

/**
 * Where a new worktree runs: on the host, or in a pod with the project's
 * compose stack. Shown only when the project's t3.json has a pod block and the
 * pod runtime is on.
 */
export const ComposerRuntimeSelector = memo(function ComposerRuntimeSelector(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly value: ThreadWorktreeRuntime;
  readonly onChange: (runtime: ThreadWorktreeRuntime) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const offersPods = useProjectOffersPods(props.environmentId, props.projectId);
  if (!offersPods) return null;
  const Icon = props.value === "container" ? BoxIcon : MonitorIcon;
  return (
    <Select
      modal={false}
      value={props.value}
      onValueChange={(value: string | null) => {
        if (value === "host" || value === "container") props.onChange(value);
      }}
      items={RUNTIME_ITEMS}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 shrink"
              aria-label="Runtime"
              data-composer-context-control
            />
          }
        >
          <Icon className="size-3" />
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {props.value === "container"
            ? "Terminals and scripts run in a pod with the project's compose stack; the agent itself still runs on this machine for now"
            : "Runs on this machine"}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Runtime</SelectGroupLabel>
          {RUNTIME_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              <span className="inline-flex items-center gap-1.5">
                {item.value === "container" ? (
                  <BoxIcon className="size-3" />
                ) : (
                  <MonitorIcon className="size-3" />
                )}
                {item.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
