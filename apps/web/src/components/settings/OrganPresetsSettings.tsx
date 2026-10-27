import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  META_PROMOTE_BLOCKER_TEXT,
  metaPromoteBlocker,
  supportsOrchestrationMetas,
  supportsOrganPresets,
} from "@t3tools/client-runtime/state/organ-presets";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH,
  type AgentRolePresetScope,
  type EffectiveOrganPreset,
  type EnvironmentId,
  ORGAN_CELL_MAX_COUNT,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { MoreHorizontalIcon, PlusIcon, RotateCcwIcon, UsersRoundIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { confirmDestructive } from "../../confirmDialog";
import { useServerConfigs } from "../../state/entities";
import { orchestrationTree } from "../../state/orchestrationTree";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  EMPTY_ORGAN_DRAFT,
  clampCellCount,
  missingCellRoles,
  type OrganDraft,
  organDraftToPreset,
  type OrganLayer,
  organPresetToDraft,
  organRowState,
} from "./organPresetsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const MAX_CELLS = 16;
/** The picker renders at most this many threads; the search narrows the rest. */
const PICKER_LIMIT = 100;

function failureMessage(result: Parameters<typeof isAtomCommandInterrupted>[0]): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

function reportFailure(title: string, result: Parameters<typeof isAtomCommandInterrupted>[0]) {
  const description = failureMessage(result);
  if (description !== null) toastManager.add({ type: "error", title, description });
}

export function OrganPresetsSettings() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const configs = useServerConfigs();
  const capabilities =
    target === null ? undefined : configs.get(target.environmentId)?.environment.capabilities;
  return (
    <SettingsPageContainer>
      {scope.kind === "unavailable" ? (
        <SettingsSection title="Unavailable selection">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      ) : target === null || !supportsOrganPresets(capabilities) ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersRoundIcon />
            </EmptyMedia>
            <EmptyTitle>Organs are unavailable</EmptyTitle>
            <EmptyDescription>
              {target === null
                ? "Connect an environment to manage organs."
                : "This environment's server does not support organs yet."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <OrganPresetsPanel
            key={`${target.environmentId}:${target.projectId ?? ""}`}
            environmentId={target.environmentId}
            projectId={target.projectId}
            // Organs belong to one environment; name it when several are connected.
            environmentLabel={connectedEnvironments.length > 1 ? target.label : null}
          />
          {supportsOrchestrationMetas(capabilities) ? (
            <MetasSection environmentId={target.environmentId} />
          ) : null}
        </>
      )}
    </SettingsPageContainer>
  );
}

function OrganPresetsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly environmentLabel: string | null;
}) {
  const layer: OrganLayer = props.projectId === null ? "environment" : "project";
  const scope: AgentRolePresetScope =
    props.projectId === null
      ? { type: "environment" }
      : { type: "project", projectId: props.projectId };
  const listInput = props.projectId === null ? {} : { projectId: props.projectId };
  const query = useEnvironmentQuery(
    serverEnvironment.organPresetsLive({ environmentId: props.environmentId, input: listInput }),
  );
  const roles = useEnvironmentQuery(
    serverEnvironment.agentRolePresetsLive({
      environmentId: props.environmentId,
      input: listInput,
    }),
  );
  const canWrite = useAtomValue(
    serverEnvironment.saveOrganPreset.permissionAtom(props.environmentId),
  );
  const removePreset = useAtomCommand(serverEnvironment.removeOrganPreset, {
    label: "organ preset remove",
  });
  const resetPresets = useAtomCommand(serverEnvironment.resetOrganPresets, {
    label: "organ preset reset",
  });
  const [editor, setEditor] = useState<{ preset: EffectiveOrganPreset | null } | null>(null);
  const presets = query.data?.presets ?? [];
  const removed = query.data?.removed ?? [];
  const roleIds = roles.data === null ? null : new Set(roles.data.presets.map((role) => role.id));

  const remove = async (preset: EffectiveOrganPreset) => {
    const confirmed = await confirmDestructive(
      preset.source === "default" || preset.inherited
        ? `Remove the ${preset.label} organ?\nYou can restore it.`
        : `Remove the ${preset.label} organ?`,
    );
    if (!confirmed) return;
    reportFailure(
      "Could not remove the organ",
      await removePreset({ environmentId: props.environmentId, input: { scope, id: preset.id } }),
    );
  };
  const reset = async (id: string | undefined) => {
    if (id === undefined) {
      const confirmed = await confirmDestructive(
        layer === "project"
          ? "Reset all organs for this project?\nIt uses the environment's organs again."
          : "Reset all organs?\nEvery organ edit and removal on this environment is dropped; the built-in organs return.",
      );
      if (!confirmed) return;
    }
    reportFailure(
      "Could not reset organs",
      await resetPresets({
        environmentId: props.environmentId,
        input: { scope, ...(id === undefined ? {} : { id }) },
      }),
    );
  };

  return (
    <>
      <SettingsSection
        title={[layer === "project" ? "Organs for this project" : "Organs", props.environmentLabel]
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
              Add organ
            </Button>
          </div>
        }
      >
        {query.error ? (
          <SettingsRow title="Could not load organs" description={query.error} />
        ) : null}
        {presets.map((preset) => {
          const row = organRowState(preset, layer, scope);
          // A role edit can orphan a cell after the save; starting the organ then refuses.
          const missing = missingCellRoles(organPresetToDraft(preset), roleIds);
          return (
            <SettingsRow
              key={preset.id}
              title={preset.label}
              description={
                <span className="flex flex-col gap-0.5">
                  <span className="font-mono">{preset.id}</span>
                  <span>
                    {preset.cells
                      .map((cell) => (cell.count > 1 ? `${cell.role} ×${cell.count}` : cell.role))
                      .join(", ")}
                  </span>
                  {missing.size > 0 ? (
                    <span className="text-warning-foreground">
                      No such role here: {[...missing].join(", ")}
                    </span>
                  ) : null}
                </span>
              }
              status={
                <Badge variant={missing.size > 0 ? "warning" : "outline"} size="sm">
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
                    {row.removeOverride !== null ? (
                      <MenuItem onClick={() => void reset(preset.id)}>Remove override</MenuItem>
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
        <SettingsSection title="Removed organs">
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
        <OrganEditorDialog
          key={editor.preset?.id ?? "new"}
          environmentId={props.environmentId}
          scope={scope}
          preset={editor.preset}
          takenIds={presets.map((preset) => preset.id)}
          roleIds={roleIds}
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

function OrganEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly scope: AgentRolePresetScope;
  readonly preset: EffectiveOrganPreset | null;
  readonly takenIds: ReadonlyArray<string>;
  readonly roleIds: ReadonlySet<string> | null;
  readonly onClose: () => void;
}) {
  const savePreset = useAtomCommand(serverEnvironment.saveOrganPreset, {
    label: "organ preset save",
  });
  const [draft, setDraft] = useState<OrganDraft>(() =>
    props.preset === null ? EMPTY_ORGAN_DRAFT : organPresetToDraft(props.preset),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<OrganDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateCell = (index: number, patch: Partial<OrganDraft["cells"][number]>) =>
    update({
      cells: draft.cells.map((cell, at) => (at === index ? { ...cell, ...patch } : cell)),
    });
  const missing = missingCellRoles(draft, props.roleIds);
  const roleChoices = [...(props.roleIds ?? [])];

  const save = async () => {
    if (draft.isNew && props.takenIds.includes(draft.id.trim())) {
      setError(`An organ with the id ${draft.id.trim()} already exists.`);
      return;
    }
    const decoded = organDraftToPreset(draft);
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
      // The server's refusal names the role and layer; show it as sent.
      setError(failureMessage(result));
      return;
    }
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.isNew ? "Add organ" : `Edit ${props.preset?.label}`}</DialogTitle>
          <DialogDescription>
            An organ starts a group of role cells on one goal. Edits here apply to{" "}
            {props.scope.type === "project" ? "this project" : "this environment"}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Label" htmlFor="organ-label">
                <Input
                  id="organ-label"
                  value={draft.label}
                  onChange={(event) => update({ label: event.target.value })}
                />
              </Field>
              <Field label="Id" htmlFor="organ-id" hint={draft.isNew ? "lowercase" : "fixed"}>
                <Input
                  id="organ-id"
                  value={draft.id}
                  disabled={!draft.isNew}
                  onChange={(event) => update({ id: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Goal template" htmlFor="organ-goal-template">
              <Textarea
                id="organ-goal-template"
                rows={4}
                maxLength={AGENT_ROLE_PRESET_INSTRUCTIONS_MAX_LENGTH}
                value={draft.goalTemplate}
                onChange={(event) => update({ goalTemplate: event.target.value })}
              />
            </Field>
            <Field label="Cells" hint={`count 1–${ORGAN_CELL_MAX_COUNT}`}>
              <div className="space-y-2">
                {draft.cells.map((cell, index) => (
                  // Cells have no id of their own and keep their order while editing.
                  // oxlint-disable-next-line react/no-array-index-key
                  <div key={index} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <Select
                          value={cell.role}
                          onValueChange={(role) => updateCell(index, { role: role as string })}
                        >
                          <SelectTrigger size="sm" aria-label={`Cell ${index + 1} role`}>
                            <SelectValue>
                              {cell.role === "" ? "Pick a role" : cell.role}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {roleChoices.map((role) => (
                              <SelectItem key={role} value={role}>
                                {role}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                      <div className="w-16">
                        <Input
                          type="number"
                          min={1}
                          max={ORGAN_CELL_MAX_COUNT}
                          aria-label={`Cell ${index + 1} count`}
                          value={cell.count}
                          onChange={(event) =>
                            updateCell(index, {
                              count: clampCellCount(event.target.valueAsNumber),
                            })
                          }
                        />
                      </div>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove cell ${index + 1}`}
                        disabled={draft.cells.length === 1}
                        onClick={() =>
                          update({ cells: draft.cells.filter((_, at) => at !== index) })
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                    {missing.has(cell.role.trim()) ? (
                      <p className="text-warning-foreground text-xs">
                        No {cell.role} role in this scope.
                      </p>
                    ) : null}
                    {cell.target ? (
                      <p className="flex items-center gap-1 text-muted-foreground text-xs">
                        Runs on {cell.target.model} instead of the role's model.
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          onClick={() => {
                            const { target: _target, ...rest } = cell;
                            update({
                              cells: draft.cells.map((entry, at) => (at === index ? rest : entry)),
                            });
                          }}
                        >
                          Use the role's model
                        </Button>
                      </p>
                    ) : null}
                  </div>
                ))}
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={draft.cells.length >= MAX_CELLS}
                  onClick={() => update({ cells: [...draft.cells, { role: "", count: 1 }] })}
                >
                  <PlusIcon className="size-3" />
                  Add cell
                </Button>
              </div>
            </Field>
            {error ? (
              <p className="text-destructive-foreground text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={saving || missing.size > 0} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MetasSection(props: { readonly environmentId: EnvironmentId }) {
  const metaKeys = useAtomValue(orchestrationTree.metaKeysAtom(props.environmentId));
  const threadIndex = useAtomValue(
    environmentThreadShells.environmentThreadIndexAtom(props.environmentId),
  );
  const setThreadMeta = useOrchestrationCommand(threadEnvironment.setMeta, {
    reportFailure: false,
  });
  const [picking, setPicking] = useState(false);
  const metas = metaKeys.flatMap((key) => {
    const ref = parseScopedThreadKey(key);
    const thread = ref === null ? undefined : threadIndex.get(ref.threadId);
    return thread === undefined ? [] : [thread];
  });

  const setMeta = async (threadId: ThreadId, enabled: boolean) =>
    reportFailure(
      enabled ? "Could not promote the thread" : "Could not demote the meta",
      await setThreadMeta({ environmentId: props.environmentId, input: { threadId, enabled } }),
    );

  return (
    <>
      <SettingsSection
        title="Metas"
        headerAction={
          <Button size="xs" variant="ghost-muted" onClick={() => setPicking(true)}>
            <PlusIcon className="size-3" />
            Promote a thread…
          </Button>
        }
      >
        {metas.length === 0 ? (
          <SettingsRow
            title="No metas"
            description="A meta is a top-level thread that stays open while it runs other threads."
          />
        ) : null}
        {metas.map((thread) => (
          <SettingsRow
            key={thread.id}
            title={thread.title}
            control={
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => void setMeta(thread.id, false)}
              >
                Demote
              </Button>
            }
          />
        ))}
      </SettingsSection>
      {picking ? (
        <PromotePickerDialog
          threads={threadIndex}
          onPick={(threadId) => {
            setPicking(false);
            void setMeta(threadId, true);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}

function PromotePickerDialog(props: {
  readonly threads: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  readonly onPick: (threadId: ThreadId) => void;
  readonly onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const rows = [...props.threads.values()]
    .filter((thread) => thread.metaAt == null)
    .filter((thread) => needle === "" || thread.title.toLowerCase().includes(needle))
    .map((thread) => ({ thread, blocker: metaPromoteBlocker(thread) }))
    // Promotable threads first, so the disabled ones explain themselves below.
    .sort((left, right) => Number(left.blocker !== null) - Number(right.blocker !== null))
    .slice(0, PICKER_LIMIT);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Promote a thread</DialogTitle>
          <DialogDescription>
            Only a top-level thread that is not supervised or archived can be a meta.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <Input
              autoFocus
              placeholder="Search threads"
              aria-label="Search threads"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">No threads match.</p>
            ) : null}
            {rows.map(({ thread, blocker }) => (
              <SettingsRow
                key={thread.id}
                title={thread.title}
                description={blocker === null ? undefined : META_PROMOTE_BLOCKER_TEXT[blocker]}
                control={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={blocker !== null}
                    onClick={() => props.onPick(thread.id)}
                  >
                    Promote
                  </Button>
                }
              />
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
