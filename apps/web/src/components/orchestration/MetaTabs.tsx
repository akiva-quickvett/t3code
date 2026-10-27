import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import { NO_META_TAB_KEY } from "@t3tools/client-runtime/state/orchestration-tree";
import { supportsOrchestrationMetas } from "@t3tools/client-runtime/state/organ-presets";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationDot as OrchestrationDotKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { memo, type MouseEvent, type ReactNode, useState } from "react";

import { cn } from "../../lib/utils";
import { getProviderInstanceEntry } from "../../providerInstances";
import { useQuietThreadShell, useThreadHistory, useThreadProjection } from "../../state/entities";
import { orchestrationTree } from "../../state/orchestrationTree";
import { environmentPresentations } from "../../state/presentation";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useUiStateStore } from "../../uiStateStore";
import { PromotePickerDialog } from "../settings/OrganPresetsSettings";
import { reportFailure } from "../settings/presetSettingsControls";
import { Menu, MenuItem, MenuPopup } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  createMetaTabAtoms,
  joinEnvironmentIds,
  metaClearAvailability,
  metaTabStatus,
  resolveSelectedTabKey,
  SET_META_FAILURE_TITLE,
  setMetaFor,
  splitEnvironmentIds,
} from "./MetaTabs.logic";
import { OrchestrationDot } from "./OrchestrationDot";

export interface MetaTabsProps {
  /**
   * Environments whose metas get tabs, in tab order; No meta covers all of
   * them. Pass the order that feeds `mergeOrchestrationOrders`, so
   * next-needs-you walks the tabs left to right.
   */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** Clear is wired by the container (`message.dispatch "/compact"`); this bar only offers it. */
  readonly onClear: (metaThreadRef: ScopedThreadRef) => void;
}

const metaTabAtoms = createMetaTabAtoms(orchestrationTree);

// Config and provider-status churn re-renders nothing unless the capable set changes.
const metaEnvironmentIdsAtom = Atom.family((environmentIdsKey: string) => {
  const environmentIds = splitEnvironmentIds(environmentIdsKey);
  let previous: ReadonlyArray<EnvironmentId> = [];
  return Atom.make((get) => {
    const configs = get(environmentPresentations.serverConfigsAtom);
    const next = environmentIds.filter((id) =>
      supportsOrchestrationMetas(configs.get(id)?.environment.capabilities),
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-meta-environment-ids:${environmentIdsKey}`));
});

// The title alone, so a meta's status changes don't re-render its tab.
const metaTitleAtom = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  return Atom.make((get) =>
    threadRef === null
      ? null
      : (get(environmentThreadShells.quietThreadShellAtom(threadRef))?.title ?? null),
  ).pipe(Atom.withLabel(`web-meta-tab-title:${threadKey}`));
});

interface MenuRequest {
  readonly threadRef: ScopedThreadRef;
  readonly anchor: Element;
}

/**
 * Reads only the meta key list and the selection; each tab subscribes to its
 * own roll-up and title, so a streaming tick re-renders at most the tab whose
 * dot or count changed.
 */
export function MetaTabs(props: MetaTabsProps) {
  const environmentIdsKey = joinEnvironmentIds(props.environmentIds);
  const tabKeys = useAtomValue(metaTabAtoms.tabKeysAtom(environmentIdsKey));
  const storedKey = useUiStateStore((state) => state.selectedMetaThreadKey);
  const setSelectedKey = useUiStateStore((state) => state.setSelectedMetaThreadKey);
  const selectedKey = resolveSelectedTabKey(tabKeys, storedKey);
  const metaEnvironmentIds = useAtomValue(metaEnvironmentIdsAtom(environmentIdsKey));
  const selectedRef = selectedKey === null ? null : parseScopedThreadKey(selectedKey);
  // "+" promotes into the selected meta's environment, else the first that has metas.
  const promoteEnvironmentId =
    selectedRef !== null && metaEnvironmentIds.includes(selectedRef.environmentId)
      ? selectedRef.environmentId
      : (metaEnvironmentIds[0] ?? null);
  const canPromote = useEnvironmentScope(promoteEnvironmentId, AuthOrchestrationOperateScope);
  const setThreadMeta = useOrchestrationCommand(threadEnvironment.setMeta, {
    reportFailure: false,
  });
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<MenuRequest | null>(null);

  const setMeta = async (threadRef: ScopedThreadRef, enabled: boolean) =>
    reportFailure(
      SET_META_FAILURE_TITLE[enabled ? "promote" : "demote"],
      await setMetaFor(setThreadMeta, threadRef, enabled),
    );

  // The compiler memoises this (it closes over a state setter only), so the
  // memoised tabs keep their props equal across bar renders.
  const openMenu = (threadRef: ScopedThreadRef, anchor: Element) => setMenu({ threadRef, anchor });

  return (
    <div
      role="tablist"
      aria-label="Metas"
      className="flex min-h-6 flex-wrap items-center gap-0.5 border-b border-border px-1.5 text-xs"
    >
      {tabKeys.map((key) => {
        if (key === NO_META_TAB_KEY) {
          return (
            <NoMetaTab
              key={key}
              environmentIdsKey={environmentIdsKey}
              selected={selectedKey === NO_META_TAB_KEY}
              onSelect={setSelectedKey}
            />
          );
        }
        const threadRef = parseScopedThreadKey(key);
        if (threadRef === null) return null;
        return (
          <MetaTab
            key={key}
            threadKey={key}
            environmentId={threadRef.environmentId}
            selected={key === selectedKey}
            onSelect={setSelectedKey}
            onOpenMenu={openMenu}
          />
        );
      })}
      {promoteEnvironmentId !== null && (
        <SpanTooltip
          text={
            canPromote ? "Promote a thread to a meta…" : "This connection cannot change threads."
          }
        >
          <button
            type="button"
            aria-label="Promote a thread to a meta"
            disabled={!canPromote}
            onClick={() => setPicking(true)}
            className="flex h-5 cursor-pointer items-center rounded-sm px-1.25 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-64"
          >
            <PlusIcon className="size-3" aria-hidden />
          </button>
        </SpanTooltip>
      )}
      {picking && promoteEnvironmentId !== null && (
        <PromotePickerDialog
          environmentId={promoteEnvironmentId}
          canOperate={canPromote}
          onPick={(threadId) => {
            setPicking(false);
            void setMeta(scopeThreadRef(promoteEnvironmentId, threadId), true);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {menu !== null && (
        <MetaTabMenu
          key={`${menu.threadRef.environmentId}:${menu.threadRef.threadId}`}
          request={menu}
          onClose={() => setMenu(null)}
          onDemote={(threadRef) => void setMeta(threadRef, false)}
          onClear={props.onClear}
        />
      )}
    </div>
  );
}

const MetaTab = memo(function MetaTab(props: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
  readonly onOpenMenu: (threadRef: ScopedThreadRef, anchor: Element) => void;
}) {
  const { dot, unread } = metaTabStatus(
    useAtomValue(orchestrationTree.rollupAtom(props.environmentId, props.threadKey)),
  );
  const label = useAtomValue(metaTitleAtom(props.threadKey)) ?? "Meta";
  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const threadRef = parseScopedThreadKey(props.threadKey);
    if (threadRef === null) return;
    event.preventDefault();
    props.onOpenMenu(threadRef, event.currentTarget);
  };
  return (
    <TabButton
      label={label}
      title={`${label} · Click again or right-click for Demote and Clear`}
      dot={dot}
      unread={unread}
      selected={props.selected}
      // Touch browsers (iOS Safari) never fire contextmenu, so a second tap opens the menu.
      onClick={(event) => (props.selected ? openMenu(event) : props.onSelect(props.threadKey))}
      onContextMenu={openMenu}
    />
  );
});

const NoMetaTab = memo(function NoMetaTab(props: {
  readonly environmentIdsKey: string;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
}) {
  const unread = useAtomValue(metaTabAtoms.noMetaUnreadAtom(props.environmentIdsKey));
  return (
    <TabButton
      label="No meta"
      title="Ad-hoc chats, slice-less pods, slices without a meta"
      dot={null}
      unread={unread}
      selected={props.selected}
      onClick={() => props.onSelect(NO_META_TAB_KEY)}
    />
  );
});

function TabButton(props: {
  readonly label: string;
  readonly title: string;
  readonly dot: OrchestrationDotKind | null;
  readonly unread: number;
  readonly selected: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <SpanTooltip text={props.title}>
      <button
        type="button"
        role="tab"
        aria-selected={props.selected}
        onClick={props.onClick}
        onContextMenu={props.onContextMenu}
        className={cn(
          "flex h-5 max-w-35 cursor-pointer select-none items-center gap-1.25 rounded-sm px-1.75 text-muted-foreground hover:text-foreground",
          props.selected && "bg-accent text-foreground ring-1 ring-border",
        )}
      >
        {props.dot !== null && <OrchestrationDot dot={props.dot} />}
        <span className="min-w-0 truncate">{props.label}</span>
        {props.unread > 0 && (
          <span
            aria-label={`${props.unread} unread`}
            className={cn(
              "min-w-3 shrink-0 rounded-md bg-muted px-1 text-center text-3xs tabular-nums",
              !props.selected && "text-muted-foreground",
            )}
          >
            {props.unread}
          </span>
        )}
      </button>
    </SpanTooltip>
  );
}

/** On a wrapper, so a disabled button still explains itself. */
function SpanTooltip(props: { readonly text: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0" />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="bottom">{props.text}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Mounted while open, so the meta's messages (for Clear's check) load only
 * when someone asks for the menu.
 */
function MetaTabMenu(props: {
  readonly request: MenuRequest;
  readonly onClose: () => void;
  readonly onDemote: (threadRef: ScopedThreadRef) => void;
  readonly onClear: (threadRef: ScopedThreadRef) => void;
}) {
  const { threadRef, anchor } = props.request;
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const metasSupported = useAtomValue(metaEnvironmentIdsAtom(threadRef.environmentId)).length > 0;
  const shell = useQuietThreadShell(threadRef);
  const providers =
    useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(
      threadRef.environmentId,
    ) ?? EMPTY_SERVER_PROVIDERS;
  const projection = useThreadProjection(threadRef);
  const { hasMoreHistory } = useThreadHistory(threadRef);
  const clear = metaClearAvailability({
    canOperate,
    provider: shell === null ? null : getProviderInstanceEntry(providers, shell.providerInstanceId),
    hasUserMessage: shell?.latestUserMessageAt != null,
    loaded:
      projection === null ? null : { messages: projection.projection.messages, hasMoreHistory },
  });
  const demoteReason = !canOperate
    ? "This connection cannot change threads."
    : !metasSupported
      ? "This environment does not support metas."
      : null;

  return (
    <Menu open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <MenuPopup anchor={anchor} align="start" side="bottom">
        <DisabledReason reason={demoteReason}>
          <MenuItem disabled={demoteReason !== null} onClick={() => props.onDemote(threadRef)}>
            Demote
          </MenuItem>
        </DisabledReason>
        <DisabledReason reason={clear.enabled ? null : clear.reason}>
          <MenuItem disabled={!clear.enabled} onClick={() => props.onClear(threadRef)}>
            Clear
          </MenuItem>
        </DisabledReason>
      </MenuPopup>
    </Menu>
  );
}

/** A disabled item takes no pointer events, so the tooltip hangs on a wrapper. */
function DisabledReason(props: { readonly reason: string | null; readonly children: ReactNode }) {
  if (props.reason === null) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="right">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}
