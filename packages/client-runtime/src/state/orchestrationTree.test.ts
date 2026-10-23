import {
  AgentRolePresetId,
  AgentRolePresetLabel,
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { presentThreadShell } from "./models.ts";
import { v2Now, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  createOrchestrationTreeAtoms,
  mergeOrchestrationOrders,
  nextNeedsYouTarget,
  nextNeedsYouThreadKey,
  NO_META_TAB_KEY,
  type OrchestrationOrderEntry,
} from "./orchestrationTree.ts";

const environmentId = EnvironmentId.make("environment-orchestration");
const keyOf = (id: string) => scopedThreadKey({ environmentId, threadId: ThreadId.make(id) });

function shell(
  id: string,
  options: {
    readonly supervisor?: string;
    readonly role?: string;
    readonly meta?: boolean;
    readonly createdSeconds?: number;
  } = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    ...v2ThreadShell,
    id: threadId,
    title: id,
    createdAt: DateTime.add(v2Now, { seconds: options.createdSeconds ?? 0 }),
    lineage: {
      rootThreadId: threadId,
      parentThreadId: null,
      relationshipToParent: null,
      ...(options.supervisor === undefined
        ? {}
        : { supervisorThreadId: ThreadId.make(options.supervisor) }),
    },
    ...(options.role === undefined
      ? {}
      : {
          rolePreset: {
            id: AgentRolePresetId.make(options.role),
            label: AgentRolePresetLabel.make(options.role),
          },
        }),
    ...(options.meta === true ? { metaAt: v2Now } : {}),
  };
}

const needsYou = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadShell => ({
  ...thread,
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(`request-${thread.id}`),
    kind: "user_input",
    createdAt: v2Now,
  },
});

function makeHarness(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  const threadsAtom = Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>(threads);
  const statusAtom = Atom.make<EnvironmentShellStatus>("live");
  const connectedAtom = Atom.make(true);
  const atoms = createOrchestrationTreeAtoms({
    environmentThreadsAtom: () => threadsAtom,
    environmentShellStatusAtom: () => statusAtom,
    environmentConnectedAtom: () => connectedAtom,
    now: () => DateTime.formatIso(v2Now),
  });
  return { registry: AtomRegistry.make(), threadsAtom, atoms };
}

describe("presentThreadShell", () => {
  it("passes metaAt through as an ISO string", () => {
    expect(presentThreadShell(environmentId, shell("meta", { meta: true })).metaAt).toBe(
      DateTime.formatIso(v2Now),
    );
    expect(presentThreadShell(environmentId, shell("plain")).metaAt).toBeUndefined();
  });
});

describe("orchestration tree atoms", () => {
  const meta = shell("meta", { meta: true });
  const slice = shell("slice", { supervisor: "meta", role: "slice", createdSeconds: 1 });
  const runId = RunId.make("slice-run");
  const running: OrchestrationV2ThreadShell = {
    ...slice,
    latestRunId: runId,
    activeRunId: runId,
    status: "running",
    itemCount: 1,
    visibleItemCount: 1,
  };

  it("keeps the structure and roll-ups through streaming ticks", () => {
    const { registry, threadsAtom, atoms } = makeHarness([meta, running]);
    const structureAtom = atoms.structureAtom(environmentId);
    const rollupAtom = atoms.rollupAtom(environmentId, keyOf("meta"));
    const disposeStructure = registry.mount(structureAtom);
    const disposeRollup = registry.mount(rollupAtom);
    try {
      const structure = registry.get(structureAtom);
      const rollup = registry.get(rollupAtom);
      expect(structure.metas).toEqual([keyOf("meta")]);
      expect(rollup?.dot).toBe("working");

      registry.set(threadsAtom, [
        meta,
        {
          ...running,
          updatedAt: DateTime.add(v2Now, { seconds: 5 }),
          itemCount: 7,
          visibleItemCount: 4,
          latestVisibleMessage: null,
        },
      ]);
      expect(registry.get(structureAtom)).toBe(structure);
      expect(registry.get(rollupAtom)).toBe(rollup);
    } finally {
      disposeStructure();
      disposeRollup();
      registry.dispose();
    }
  });

  it("changes the structure when a thread becomes a meta", () => {
    const { registry, threadsAtom, atoms } = makeHarness([meta, slice]);
    const structureAtom = atoms.structureAtom(environmentId);
    const metaKeysAtom = atoms.metaKeysAtom(environmentId);
    const dispose = registry.mount(metaKeysAtom);
    try {
      const structure = registry.get(structureAtom);
      const metas = registry.get(metaKeysAtom);
      registry.set(threadsAtom, [meta, slice, shell("second", { meta: true, createdSeconds: 2 })]);
      expect(registry.get(structureAtom)).not.toBe(structure);
      expect(registry.get(metaKeysAtom)).not.toBe(metas);
      expect(registry.get(metaKeysAtom)).toEqual([keyOf("meta"), keyOf("second")]);
    } finally {
      dispose();
      registry.dispose();
    }
  });

  it("orders tabs depth first and marks the thread that holds a cell's request", () => {
    const cell = needsYou(shell("cell", { supervisor: "slice", role: "implementor" }));
    const { registry, atoms } = makeHarness([
      meta,
      slice,
      cell,
      needsYou(shell("adhoc", { createdSeconds: 3 })),
    ]);
    try {
      expect(registry.get(atoms.orderAtom(environmentId))).toEqual([
        { threadKey: keyOf("meta"), tabKey: keyOf("meta"), needsYou: false },
        { threadKey: keyOf("slice"), tabKey: keyOf("meta"), needsYou: true },
        { threadKey: keyOf("cell"), tabKey: keyOf("meta"), needsYou: false },
        { threadKey: keyOf("adhoc"), tabKey: NO_META_TAB_KEY, needsYou: true },
      ]);
      expect(registry.get(atoms.rollupAtom(environmentId, keyOf("slice")))).toEqual({
        dot: "needs-you",
        needsYouCount: 1,
      });
      expect(registry.get(atoms.rollupAtom(environmentId, NO_META_TAB_KEY))).toEqual({
        dot: "needs-you",
        needsYouCount: 1,
        unread: 1,
      });
    } finally {
      registry.dispose();
    }
  });
});

describe("next needs-you from a cell", () => {
  it("continues after the cell's row instead of restarting", () => {
    const meta = shell("meta", { meta: true });
    const { registry, atoms } = makeHarness([
      meta,
      needsYou(shell("s0", { supervisor: "meta", role: "slice", createdSeconds: 1 })),
      shell("s1", { supervisor: "meta", role: "slice", createdSeconds: 2 }),
      shell("cell", { supervisor: "s1", role: "implementor", createdSeconds: 3 }),
      needsYou(shell("s2", { supervisor: "meta", role: "slice", createdSeconds: 4 })),
    ]);
    try {
      const order = registry.get(atoms.orderAtom(environmentId));
      expect(nextNeedsYouTarget(order, keyOf("cell"))?.threadKey).toBe(keyOf("s2"));
    } finally {
      registry.dispose();
    }
  });
});

describe("mergeOrchestrationOrders", () => {
  it("puts every meta tab before every No meta tab", () => {
    const entry = (threadKey: string, tabKey: string) => ({ threadKey, tabKey, needsYou: true });
    expect(
      mergeOrchestrationOrders([
        [entry("a:m", "a:m"), entry("a:x", NO_META_TAB_KEY)],
        [entry("b:m", "b:m"), entry("b:x", NO_META_TAB_KEY)],
      ]).map((value) => value.threadKey),
    ).toEqual(["a:m", "b:m", "a:x", "b:x"]);
  });
});

describe("nextNeedsYouThreadKey", () => {
  const order = ["a", "b", "c"];

  it("moves to the next needs-you thread after the current one", () => {
    expect(nextNeedsYouThreadKey(order, new Set(["a", "c"]), "a")).toBe("c");
  });

  it("wraps from the end to the first", () => {
    expect(nextNeedsYouThreadKey(order, new Set(["a", "c"]), "c")).toBe("a");
  });

  it("starts from the first when the current thread is not listed", () => {
    expect(nextNeedsYouThreadKey(order, new Set(["b", "c"]), "elsewhere")).toBe("b");
    expect(nextNeedsYouThreadKey(order, new Set(["b", "c"]), null)).toBe("b");
  });

  it("returns null when nothing needs you", () => {
    expect(nextNeedsYouThreadKey(order, new Set(), "a")).toBeNull();
    expect(nextNeedsYouThreadKey([], new Set(), null)).toBeNull();
  });
});

describe("nextNeedsYouTarget", () => {
  it("names the tab that holds the target", () => {
    const entries: ReadonlyArray<OrchestrationOrderEntry> = [
      { threadKey: "m1", tabKey: "m1", needsYou: false },
      { threadKey: "s1", tabKey: "m1", needsYou: false },
      { threadKey: "m2", tabKey: "m2", needsYou: false },
      { threadKey: "s2", tabKey: "m2", needsYou: true },
    ];
    expect(nextNeedsYouTarget(entries, "s1")).toEqual(entries[3]);
    expect(nextNeedsYouTarget(entries.slice(0, 2), "s1")).toBeNull();
  });
});
