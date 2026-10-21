import { podRuntimeWarningMessage } from "@t3tools/client-runtime/state/pod-runtime";
import type { EnvironmentId, PodRuntimeWarning } from "@t3tools/contracts";

import { usePodRuntimeWarnings } from "../../state/podRuntime";
import { Alert, AlertDescription } from "../ui/alert";

export function PodRuntimeWarningList(props: {
  readonly warnings: ReadonlyArray<PodRuntimeWarning>;
}) {
  if (props.warnings.length === 0) return null;
  return (
    <>
      {props.warnings.map((warning) => (
        <Alert key={warning} variant="warning">
          <AlertDescription>{podRuntimeWarningMessage(warning)}</AlertDescription>
        </Alert>
      ))}
    </>
  );
}

/** The environment's pod warnings where its network access is set up. */
export function PodRuntimeWarnings(props: { readonly environmentId: EnvironmentId | null }) {
  const warnings = usePodRuntimeWarnings(props.environmentId);
  if (warnings.length === 0) return null;
  return (
    <div className="px-4 py-2.5 sm:px-5">
      <PodRuntimeWarningList warnings={warnings} />
    </div>
  );
}
