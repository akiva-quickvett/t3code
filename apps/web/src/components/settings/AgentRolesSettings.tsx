import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH,
  type AgentRolePresetScope,
  type EffectiveAgentRolePreset,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { MoreHorizontalIcon, PlusIcon, RotateCcwIcon, UserRoundCogIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { confirmDestructive } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentSupportsRolePresets } from "../../state/agentRoles";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  EMPTY_ROLE_DRAFT,
  draftToPreset,
  presetToDraft,
  type RoleDraft,
  type RoleLayer,
  roleRowState,
} from "./agentRolesSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

function reportFailure(title: string, result: Parameters<typeof isAtomCommandInterrupted>[0]) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The request failed.",
  });
}

export function AgentRolesSettings() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const supported = useEnvironmentSupportsRolePresets(target?.environmentId ?? null);
  return (
    <SettingsPageContainer>
      {scope.kind === "unavailable" ? (
        <SettingsSection title="Unavailable selection">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      ) : target === null || !supported ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserRoundCogIcon />
            </EmptyMedia>
            <EmptyTitle>Roles are unavailable</EmptyTitle>
            <EmptyDescription>
              {target === null
                ? "Connect an environment to manage agent roles."
                : "This environment's server does not support agent roles yet."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <AgentRolesPanel
          key={`${target.environmentId}:${target.projectId ?? ""}`}
          environmentId={target.environmentId}
          projectId={target.projectId}
          // Roles belong to one environment; name it when several are connected.
          environmentLabel={connectedEnvironments.length > 1 ? target.label : null}
        />
      )}
    </SettingsPageContainer>
  );
}

function AgentRolesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly environmentLabel: string | null;
}) {
  const layer: RoleLayer = props.projectId === null ? "environment" : "project";
  const scope: AgentRolePresetScope =
    props.projectId === null
      ? { type: "environment" }
      : { type: "project", projectId: props.projectId };
  const query = useEnvironmentQuery(
    serverEnvironment.agentRolePresetsLive({
      environmentId: props.environmentId,
      input: props.projectId === null ? {} : { projectId: props.projectId },
    }),
  );
  const canWrite = useAtomValue(
    serverEnvironment.saveAgentRolePreset.permissionAtom(props.environmentId),
  );
  const removePreset = useAtomCommand(serverEnvironment.removeAgentRolePreset, {
    label: "agent role remove",
  });
  const resetPresets = useAtomCommand(serverEnvironment.resetAgentRolePresets, {
    label: "agent role reset",
  });
  const [editor, setEditor] = useState<{ preset: EffectiveAgentRolePreset | null } | null>(null);
  const presets = query.data?.presets ?? [];
  const removed = query.data?.removed ?? [];

  const remove = async (preset: EffectiveAgentRolePreset) => {
    const confirmed = await confirmDestructive(
      preset.source === "default" || preset.inherited
        ? `Remove the ${preset.label} role?\nThreads that have it keep its name, and you can restore it.`
        : `Remove the ${preset.label} role?\nThreads that have it keep its name.`,
    );
    if (!confirmed) return;
    reportFailure(
      "Could not remove the role",
      await removePreset({
        environmentId: props.environmentId,
        input: { scope, id: preset.id },
      }),
    );
  };
  const reset = async (id: string | undefined) => {
    if (id === undefined) {
      const confirmed = await confirmDestructive(
        layer === "project"
          ? "Reset all roles for this project?\nIts role edits and removals are dropped; it uses the environment's roles."
          : "Reset all roles?\nEvery role edit and removal on this environment is dropped; the built-in roles return.",
      );
      if (!confirmed) return;
    }
    reportFailure(
      "Could not reset roles",
      await resetPresets({
        environmentId: props.environmentId,
        input: { scope, ...(id === undefined ? {} : { id }) },
      }),
    );
  };

  return (
    <>
      <SettingsSection
        title={[layer === "project" ? "Roles for this project" : "Roles", props.environmentLabel]
          .filter((part) => part !== null)
          .join(" · ")}
        headerAction={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canWrite}
              onClick={() => void reset(undefined)}
            >
              <RotateCcwIcon className="size-3" />
              Reset all
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canWrite}
              onClick={() => setEditor({ preset: null })}
            >
              <PlusIcon className="size-3" />
              Add role
            </Button>
          </div>
        }
      >
        {query.error ? (
          <SettingsRow title="Could not load roles" description={query.error} />
        ) : null}
        {presets.map((preset) => {
          const row = roleRowState(preset, layer);
          return (
            <SettingsRow
              key={preset.id}
              title={preset.label}
              description={
                <span className="flex flex-col gap-0.5">
                  <span className="font-mono">{preset.id}</span>
                  <span>
                    {preset.unavailable?.reason ??
                      preset.resolvedModelSelection?.model ??
                      preset.target.model}
                    {preset.contextWindow ? ` · ${preset.contextWindow} context (Claude only)` : ""}
                    {preset.runsIn ? ` · runs in ${preset.runsIn}` : ""}
                  </span>
                </span>
              }
              status={
                <Badge variant={preset.unavailable ? "warning" : "outline"} size="sm">
                  {row.sourceLabel}
                </Badge>
              }
              control={
                <Menu>
                  <MenuTrigger
                    disabled={!canWrite}
                    render={
                      <Button size="icon-xs" variant="ghost" aria-label={`${preset.label} actions`}>
                        <MoreHorizontalIcon />
                      </Button>
                    }
                  />
                  <MenuPopup align="end">
                    <MenuItem onClick={() => setEditor({ preset })}>Edit</MenuItem>
                    {row.canReset ? (
                      <MenuItem onClick={() => void reset(preset.id)}>Reset to default</MenuItem>
                    ) : null}
                    <MenuSeparator />
                    <MenuItem variant="destructive" onClick={() => void remove(preset)}>
                      Remove
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              }
            />
          );
        })}
      </SettingsSection>
      {removed.length > 0 ? (
        <SettingsSection title="Removed roles">
          {removed.map((entry) => (
            <SettingsRow
              key={entry.id}
              title={entry.label}
              description={
                entry.removedIn === layer
                  ? entry.id
                  : `${entry.id} · removed for the whole environment`
              }
              control={
                entry.removedIn === layer ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={!canWrite}
                    onClick={() => void reset(entry.id)}
                  >
                    Restore
                  </Button>
                ) : null
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      {editor ? (
        <AgentRoleEditorDialog
          key={editor.preset?.id ?? "new"}
          environmentId={props.environmentId}
          projectId={props.projectId}
          scope={scope}
          preset={editor.preset}
          takenIds={presets.map((preset) => preset.id)}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

function Field(props: {
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

function OptionalSelect<Value extends string>(props: {
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

function ModelOptionsEditor(props: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly options: ReadonlyArray<ProviderOptionSelection>;
  readonly onChange: (options: ReadonlyArray<ProviderOptionSelection>) => void;
}) {
  const setOption = (id: string, value: ProviderOptionSelection["value"] | null) =>
    props.onChange([
      ...props.options.filter((option) => option.id !== id),
      ...(value === null ? [] : [{ id, value }]),
    ]);
  return (
    <div className="grid grid-cols-2 gap-3">
      {props.descriptors.map((descriptor) => {
        const current = props.options.find((option) => option.id === descriptor.id)?.value;
        return descriptor.type === "boolean" ? (
          <Field key={descriptor.id} label={descriptor.label}>
            <Switch
              checked={current === true}
              onCheckedChange={(checked) => setOption(descriptor.id, checked ? true : null)}
            />
          </Field>
        ) : (
          <Field key={descriptor.id} label={descriptor.label}>
            <OptionalSelect
              id={`role-option-${descriptor.id}`}
              value={typeof current === "string" ? current : ""}
              choices={descriptor.options.map((choice) => ({
                value: choice.id,
                label: choice.label,
              }))}
              emptyLabel="Model default"
              onChange={(value) => setOption(descriptor.id, value === "" ? null : value)}
            />
          </Field>
        );
      })}
    </div>
  );
}

function AgentRoleEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly scope: AgentRolePresetScope;
  readonly preset: EffectiveAgentRolePreset | null;
  readonly takenIds: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const savePreset = useAtomCommand(serverEnvironment.saveAgentRolePreset, {
    label: "agent role save",
  });
  const [draft, setDraft] = useState<RoleDraft>(() =>
    props.preset === null ? EMPTY_ROLE_DRAFT : presetToDraft(props.preset),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<RoleDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      props.projectId,
    ),
  );
  // An unpinned default with no usable instance has none yet; the picker shows nothing chosen.
  const activeInstanceId = draft.instanceId as ProviderInstanceId;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    draft.model,
  );
  const descriptors =
    providers
      .find((provider) => provider.instanceId === draft.instanceId)
      ?.models.find((model) => model.slug === draft.model)?.capabilities?.optionDescriptors ?? [];
  const isClaude = draft.driverKind === "claudeAgent";

  const save = async () => {
    if (draft.isNew && props.takenIds.includes(draft.id.trim())) {
      setError(`A role with the id ${draft.id.trim()} already exists.`);
      return;
    }
    const decoded = draftToPreset(draft);
    if ("error" in decoded) {
      setError(decoded.error);
      return;
    }
    setSaving(true);
    const result = await savePreset({
      environmentId: props.environmentId,
      input: { scope: props.scope, preset: decoded.preset },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      reportFailure("Could not save the role", result);
      return;
    }
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.isNew ? "Add role" : `Edit ${props.preset?.label}`}</DialogTitle>
          <DialogDescription>
            A role sets a new thread's model, modes and instructions. Edits here apply to{" "}
            {props.scope.type === "project" ? "this project" : "this environment"}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Label" htmlFor="role-label">
                <Input
                  id="role-label"
                  value={draft.label}
                  onChange={(event) => update({ label: event.target.value })}
                />
              </Field>
              <Field label="Id" htmlFor="role-id" hint={draft.isNew ? "lowercase" : "fixed"}>
                <Input
                  id="role-id"
                  value={draft.id}
                  disabled={!draft.isNew}
                  onChange={(event) => update({ id: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Model">
              <ProviderModelPicker
                environmentId={props.environmentId}
                activeInstanceId={activeInstanceId}
                model={draft.model}
                providerLock={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  update({
                    instanceId,
                    driverKind:
                      instanceEntries.find((entry) => entry.instanceId === instanceId)
                        ?.driverKind ?? draft.driverKind,
                    model,
                    options: model === draft.model ? draft.options : [],
                  })
                }
              />
            </Field>
            <SettingsRow
              title="Pin to this provider instance"
              description="Off: any enabled instance of the same provider runs the role."
              control={
                <Switch
                  checked={draft.pinInstance}
                  onCheckedChange={(pinInstance) => update({ pinInstance })}
                />
              }
            />
            {descriptors.length > 0 ? (
              <ModelOptionsEditor
                descriptors={descriptors}
                options={draft.options}
                onChange={(options) => update({ options })}
              />
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Runtime mode" htmlFor="role-runtime-mode">
                <OptionalSelect
                  id="role-runtime-mode"
                  value={draft.runtimeMode}
                  emptyLabel="Inherit"
                  choices={[
                    { value: "approval-required", label: "Approval required" },
                    { value: "auto-accept-edits", label: "Auto-accept edits" },
                    { value: "auto", label: "Auto" },
                    { value: "full-access", label: "Full access" },
                  ]}
                  onChange={(runtimeMode) => update({ runtimeMode })}
                />
              </Field>
              <Field label="Interaction mode" htmlFor="role-interaction-mode">
                <OptionalSelect
                  id="role-interaction-mode"
                  value={draft.interactionMode}
                  emptyLabel="Inherit"
                  choices={[
                    { value: "default", label: "Build" },
                    { value: "plan", label: "Plan" },
                  ]}
                  onChange={(interactionMode) => update({ interactionMode })}
                />
              </Field>
              <Field label="Isolation" hint="delegated tasks" htmlFor="role-isolation">
                <OptionalSelect
                  id="role-isolation"
                  value={draft.isolation}
                  emptyLabel="Caller decides"
                  choices={[
                    { value: "shared", label: "Shared checkout" },
                    { value: "worktree", label: "Own worktree" },
                  ]}
                  onChange={(isolation) => update({ isolation })}
                />
              </Field>
              <Field
                label="Context window"
                hint={isClaude ? "Claude only" : "Claude only; ignored here"}
                htmlFor="role-context-window"
              >
                <OptionalSelect
                  id="role-context-window"
                  value={draft.contextWindow}
                  emptyLabel="Provider default"
                  choices={[
                    { value: "200k", label: "200k" },
                    { value: "1m", label: "1M" },
                  ]}
                  onChange={(contextWindow) => update({ contextWindow })}
                />
              </Field>
              <Field label="Runs in" hint="recorded for pods" htmlFor="role-runs-in">
                <OptionalSelect
                  id="role-runs-in"
                  value={draft.runsIn}
                  emptyLabel="Unspecified"
                  choices={[
                    { value: "host", label: "Host" },
                    { value: "pod", label: "Pod" },
                  ]}
                  onChange={(runsIn) => update({ runsIn })}
                />
              </Field>
            </div>
            <Field label="Instructions" htmlFor="role-instructions">
              <Textarea
                id="role-instructions"
                rows={5}
                maxLength={AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH}
                value={draft.instructions}
                onChange={(event) => update({ instructions: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Skills" hint="comma separated" htmlFor="role-skills">
                <Input
                  id="role-skills"
                  value={draft.skills}
                  onChange={(event) => update({ skills: event.target.value })}
                />
              </Field>
              <Field
                label="Child roles"
                hint="comma separated, not enforced"
                htmlFor="role-child-roles"
              >
                <Input
                  id="role-child-roles"
                  value={draft.allowedChildRoles}
                  onChange={(event) => update({ allowedChildRoles: event.target.value })}
                />
              </Field>
            </div>
            {error ? (
              <p className="text-destructive-foreground text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={saving} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
