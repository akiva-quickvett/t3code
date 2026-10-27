import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type OrchestrationStatsSnapshot, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "~/index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const { Atom, AsyncResult, AtomRegistry } = await import("effect/reactivity");
  type Result = ReturnType<typeof AsyncResult.success<OrchestrationStatsSnapshot>>;
  const streams = {
    opened: 0,
    closed: 0,
    push: null as ((snapshot: OrchestrationStatsSnapshot) => void) | null,
  };
  // Stands in for the RPC subscription: built on mount, finalized on release.
  const statsAtom = Atom.family((_environmentId: string) =>
    Atom.make((get): Result | ReturnType<typeof AsyncResult.initial> => {
      streams.opened += 1;
      get.addFinalizer(() => {
        streams.closed += 1;
        streams.push = null;
      });
      streams.push = (snapshot) => get.setSelf(AsyncResult.success(snapshot));
      return AsyncResult.initial(true);
    }),
  );
  return {
    registry: AtomRegistry.make(),
    streams,
    statsAtom,
    capabilities: new Map<string, { readonly orchestrationStats?: boolean }>(),
  };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    orchestrationStatsLive: (target: { readonly environmentId: string }) =>
      h.statsAtom(target.environmentId),
  },
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () =>
    new Map(
      [...h.capabilities].map(([environmentId, capabilities]) => [
        environmentId,
        { environment: { capabilities } },
      ]),
    ),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: h.registry }));

import { sliceBurn, StatsStrip } from "./StatsStrip";

const environmentId = EnvironmentId.make("environment-stats");
const sliceId = ThreadId.make("slice-s");
const workId = ThreadId.make("meta-work");

function snapshot(overrides: Partial<OrchestrationStatsSnapshot> = {}): OrchestrationStatsSnapshot {
  return {
    activeAgents: { runningTurns: 4, liveSessions: 7, idleSessions: 3 },
    burn: {
      state: "ready",
      tokensPerMinute: 18_000,
      usdPerHour: 4.2,
      approximate: false,
      perMeta: {},
      perSlice: { [sliceId]: { tokensPerMinute: 3_000, usdPerHour: 1.1 } },
    },
    host: { verdict: "ok", cpu: 0.2, ram: 0.5, swap: 0.1, load: 0.4 },
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

function render(metas?: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>) {
  return act(() =>
    root.render(
      <RegistryContext.Provider value={h.registry}>
        <StatsStrip environmentId={environmentId} {...(metas ? { metas } : {})} />
      </RegistryContext.Provider>,
    ),
  );
}

const push = (value: OrchestrationStatsSnapshot) => act(() => h.streams.push?.(value));
const summary = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim();

beforeEach(() => {
  h.streams.opened = 0;
  h.streams.closed = 0;
  h.capabilities.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe("StatsStrip", () => {
  it("holds one subscription while mounted and closes it on unmount", async () => {
    h.capabilities.set(environmentId, { orchestrationStats: true });
    await render();
    expect(h.streams.opened).toBe(1);
    expect(summary()).toBeNull();
    expect(container.childElementCount).toBe(1);

    await push(snapshot());
    expect(text(summary())).toBe("7 active · 3 idle│18k tok/m · $4.2/h│hostok");
    expect(summary()?.getAttribute("aria-label")).toBe(
      "7 active · 3 idle, 18k tok/m · $4.2/h, host ok",
    );

    await act(() => summary()?.click());
    expect(summary()?.getAttribute("aria-expanded")).toBe("true");
    await render([{ threadId: workId, title: "Work" }]);
    expect(h.streams.opened).toBe(1);
    expect(h.streams.closed).toBe(0);

    await act(() => root.unmount());
    expect(h.streams.closed).toBe(1);
    root = createRoot(container);
  });

  it("updates the line when the server pushes a change", async () => {
    h.capabilities.set(environmentId, { orchestrationStats: true });
    await render();
    await push(snapshot());
    await push(
      snapshot({
        burn: { ...snapshot().burn, state: "warming" },
        host: { verdict: "low", cpu: 0.2, ram: 0.9, swap: 0.1, load: 0.4 },
      }),
    );
    expect(text(summary())).toBe("7 active · 3 idle│≈ warming│hostlow");
    expect(h.streams.opened).toBe(1);
  });

  it("shows the per-meta row only for metas with a figure", async () => {
    h.capabilities.set(environmentId, { orchestrationStats: true });
    await render([{ threadId: workId, title: "Work" }]);
    await push(snapshot());
    await act(() => summary()?.click());
    expect(container.textContent).not.toContain("Work");

    await push(
      snapshot({
        burn: {
          ...snapshot().burn,
          perMeta: { [workId]: { tokensPerMinute: 15_000, usdPerHour: 3.6 } },
        },
      }),
    );
    expect(container.textContent).toContain("Work$3.6/h");
  });

  it("reads a slice's burn without opening a subscription", async () => {
    expect(sliceBurn(environmentId, sliceId)).toBeNull();
    expect(h.streams.opened).toBe(0);

    h.capabilities.set(environmentId, { orchestrationStats: true });
    await render();
    await push(snapshot());
    expect(sliceBurn(environmentId, sliceId)).toEqual({ tokensPerMinute: 3_000, usdPerHour: 1.1 });
    expect(h.streams.opened).toBe(1);

    await act(() => root.unmount());
    await act(async () => {});
    expect(sliceBurn(environmentId, sliceId)).toBeNull();
    expect(h.streams.opened).toBe(1);
    root = createRoot(container);
  });

  it("renders nothing and opens no subscription without the capability", async () => {
    await render();
    expect(container.childElementCount).toBe(0);
    expect(h.streams.opened).toBe(0);
  });
});
