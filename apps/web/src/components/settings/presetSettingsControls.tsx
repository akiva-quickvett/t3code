import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

type CommandResult = Parameters<typeof isAtomCommandInterrupted>[0];

/** The failure's message, or null when the command succeeded or was interrupted. */
export function failureMessage(result: CommandResult): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

export function reportFailure(title: string, result: CommandResult) {
  const description = failureMessage(result);
  if (description !== null) toastManager.add({ type: "error", title, description });
}

export function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={props.htmlFor}>
        <span>{props.label}</span>
        {props.hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{props.hint}</span>
        ) : null}
      </Label>
      {props.children}
    </div>
  );
}

const INHERIT = "inherit";

export function OptionalSelect<Value extends string>(props: {
  readonly id: string;
  readonly value: Value | "";
  readonly choices: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly emptyLabel: string;
  readonly onChange: (value: Value | "") => void;
}) {
  const label = props.choices.find((choice) => choice.value === props.value)?.label;
  return (
    <Select
      value={props.value === "" ? INHERIT : props.value}
      onValueChange={(value) => props.onChange(value === INHERIT ? "" : (value as Value))}
    >
      <SelectTrigger id={props.id} size="sm">
        <SelectValue>{label ?? props.emptyLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={INHERIT}>{props.emptyLabel}</SelectItem>
        {props.choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Picks a preset's provider instance and model from the environment's
 * instances. Without an instance, an unpinned target shows on its driver's
 * first available instance, or on none when the driver has none here.
 */
export function PresetModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly instanceId: string;
  readonly driverKind: string;
  readonly model: string;
  readonly onChange: (next: {
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: string;
    readonly model: string;
  }) => void;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      props.projectId,
    ),
  );
  const activeInstanceId = (props.instanceId ||
    instanceEntries.find((entry) => entry.isAvailable && entry.driverKind === props.driverKind)
      ?.instanceId ||
    "") as ProviderInstanceId;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    props.model,
  );
  return (
    <ProviderModelPicker
      environmentId={props.environmentId}
      activeInstanceId={activeInstanceId}
      model={props.model}
      providerLock={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      isComposerOwned={false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      onInstanceModelChange={(instanceId, model) =>
        props.onChange({
          instanceId,
          driverKind:
            instanceEntries.find((entry) => entry.instanceId === instanceId)?.driverKind ??
            props.driverKind,
          model,
        })
      }
    />
  );
}

/** Presets removed at a layer that a lower layer still defines, each restorable where removed. */
export function RemovedPresetsSection(props: {
  readonly title: string;
  readonly layer: "environment" | "project";
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly removedIn: "environment" | "project";
  }>;
  readonly canWrite: boolean;
  readonly onRestore: (id: string) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <SettingsSection title={props.title}>
      {props.entries.map((entry) => (
        <SettingsRow
          key={entry.id}
          title={entry.label}
          description={
            entry.removedIn === props.layer
              ? entry.id
              : `${entry.id} · removed for the whole environment`
          }
          control={
            entry.removedIn === props.layer ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!props.canWrite}
                onClick={() => props.onRestore(entry.id)}
              >
                Restore
              </Button>
            ) : null
          }
        />
      ))}
    </SettingsSection>
  );
}
