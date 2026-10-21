import type { ThreadRoleBadge } from "@t3tools/client-runtime/state/agent-roles";

import { useThreadRoleBadge } from "../../state/agentRoles";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function RoleBadge(props: { readonly badge: ThreadRoleBadge }) {
  if (!props.badge.missing) {
    return (
      <Badge variant="secondary" size="sm">
        {props.badge.label}
      </Badge>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant="warning" size="sm">
            {props.badge.label}
          </Badge>
        }
      />
      <TooltipPopup side="top">This role's preset was removed</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Its own component so a preset rename re-renders only this badge, never the
 * row or list around it.
 */
export function ThreadRoleBadge(props: {
  readonly thread: Parameters<typeof useThreadRoleBadge>[0];
}) {
  const badge = useThreadRoleBadge(props.thread);
  return badge === null ? null : <RoleBadge badge={badge} />;
}
