import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { OrchestrationSidebarProps } from "../orchestration/OrchestrationSidebar";

const h = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  return {
    registry: AtomRegistry.make(),
    catalogAtom: Atom.make<{
      readonly isReady: boolean;
      readonly entries: ReadonlyMap<string, { readonly enabled: boolean }>;
    }>({ isReady: true, entries: new Map() }),
    configsAtom: Atom.make<
      ReadonlyMap<
        string,
        { readonly environment: { readonly capabilities: { orchestrationMetas?: boolean } } }
      >
    >(new Map()),
    sidebarProps: null as OrchestrationSidebarProps | null,
    dispatched: [] as Array<{ readonly command: unknown; readonly value: unknown }>,
  };
});

vi.mock("../orchestration/OrchestrationSidebar", () => ({
  OrchestrationSidebar: (props: OrchestrationSidebarProps) => {
    h.sidebarProps = props;
    return null;
  },
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: h.catalogAtom },
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: h.configsAtom }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: h.registry }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: "start-turn" } }));
vi.mock("../../state/use-orchestration-command", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useOrchestrationCommand: (command: unknown) => async (value: unknown) => {
      h.dispatched.push({ command, value });
      return AsyncResult.success(undefined);
    },
  };
});
vi.mock("../../state/entities", () => ({
  readThreadShell: (ref: ScopedThreadRef) => ({
    id: ref.threadId,
    environmentId: ref.environmentId,
    title: "Work",
    runtimeMode: "approval-required",
    interactionMode: "plan",
  }),
}));

import { OrchestrationSidebarHost } from "./OrchestrationSidebarHost";
import {
  readOrchestrationEnvironmentIds,
  useOrchestrationEnvironmentIds,
} from "./orchestrationEnvironments";

const local = EnvironmentId.make("environment-local");
const remote = EnvironmentId.make("environment-remote");
const metaRef = { environmentId: local, threadId: ThreadId.make("meta-work") };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.sidebarProps = null;
  h.dispatched = [];
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderHost(props: {
  readonly onCommitRename?: (ref: ScopedThreadRef, title: string, originalTitle: string) => void;
  readonly onRowActivate?: () => void;
}) {
  return act(() =>
    root.render(
      <RegistryContext.Provider value={h.registry}>
        <OrchestrationSidebarHost
          environmentIds={[local]}
          onCommitRename={props.onCommitRename ?? (() => undefined)}
          onRowActivate={props.onRowActivate ?? (() => undefined)}
        />
      </RegistryContext.Provider>,
    ),
  );
}

describe("OrchestrationSidebarHost", () => {
  it("clears a meta with a user /compact queued behind its running turn", async () => {
    await renderHost({});
    await act(async () => h.sidebarProps!.onClearMeta(metaRef));
    expect(h.dispatched).toEqual([
      {
        command: "start-turn",
        value: {
          environmentId: local,
          input: {
            threadId: metaRef.threadId,
            message: {
              messageId: expect.any(String),
              role: "user",
              text: "/compact",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            // "queue" is `queue_after_active`; no creationSource override keeps
            // the client's own web origin, so held supervised wakes release.
            dispatchMode: "queue",
          },
        },
      },
    ]);
  });

  it("hands stable callbacks to the view across renders", async () => {
    await renderHost({});
    const first = h.sidebarProps!;
    await renderHost({ onRowActivate: () => undefined });
    expect(h.sidebarProps!.onClearMeta).toBe(first.onClearMeta);
    expect(h.sidebarProps!.onRenameThread).toBe(first.onRenameThread);
  });

  it("renames through the chat view's commit", async () => {
    const onCommitRename = vi.fn();
    await renderHost({ onCommitRename });
    await act(async () => h.sidebarProps!.onRenameThread(metaRef));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Thread title"]')!;
    expect(input.value).toBe("Work");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "Planning");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onCommitRename).toHaveBeenCalledWith(metaRef, "Planning", "Work");
  });
});

describe("useOrchestrationEnvironmentIds", () => {
  let seen: Array<ReadonlyArray<EnvironmentId>> = [];
  function Probe() {
    seen.push(useOrchestrationEnvironmentIds());
    return null;
  }

  it("keeps enabled environments with metas, in catalog order, by reference", async () => {
    seen = [];
    h.registry.set(h.catalogAtom, {
      isReady: true,
      entries: new Map([
        [remote, { enabled: true }],
        ["environment-off", { enabled: false }],
        [local, { enabled: true }],
      ]),
    });
    const metas = { environment: { capabilities: { orchestrationMetas: true } } };
    h.registry.set(
      h.configsAtom,
      new Map([
        [remote, metas],
        ["environment-off", metas],
        [local, metas],
      ]),
    );
    await act(() =>
      root.render(
        <RegistryContext.Provider value={h.registry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
    expect(seen.at(-1)).toEqual([remote, local]);
    // The shortcut, menu action and palette gate on the same list.
    expect(readOrchestrationEnvironmentIds()).toBe(seen.at(-1));
    const renders = seen.length;

    // A config change that leaves the capable set alone renders nothing.
    await act(() =>
      h.registry.set(
        h.configsAtom,
        new Map([
          [remote, metas],
          [local, metas],
        ]),
      ),
    );
    expect(seen.length).toBe(renders);

    await act(() => h.registry.set(h.configsAtom, new Map([[local, metas]])));
    expect(seen.at(-1)).toEqual([local]);

    // Handlers outside React read it as it is now.
    h.registry.set(h.configsAtom, new Map([[remote, metas]]));
    expect(readOrchestrationEnvironmentIds()).toEqual([remote]);
    h.registry.set(h.configsAtom, new Map());
    expect(readOrchestrationEnvironmentIds()).toEqual([]);
  });
});
