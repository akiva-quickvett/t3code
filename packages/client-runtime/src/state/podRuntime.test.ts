import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PodRuntimeId,
  type PodRuntimeOperation,
  type PodRuntimeSnapshot,
  type PodRuntimeState,
  ProjectId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  EMPTY_POD_RUNTIME_STATE,
  podBrowsingThread,
  podFailureActions,
  podForWorktree,
  podServiceLinks,
  podRuntimeActions,
  podRuntimeTitle,
  reducePodRuntimeEvent,
} from "./podRuntime.ts";

const pod = (
  state: PodRuntimeState,
  failed?: PodRuntimeOperation,
  id = "pod-one",
): PodRuntimeSnapshot => ({
  id: PodRuntimeId.make(id),
  projectId: ProjectId.make("project-1"),
  worktreePath: "/work/trees/feature",
  state,
  services: [],
  image: "image",
  startedAt: null,
  lastError: failed === undefined ? null : { operation: failed, message: "boom", at: "t" },
  containerIds: [],
  volumeIds: [],
  updatedAt: "t",
});

const labels = (snapshot: PodRuntimeSnapshot) =>
  podRuntimeActions(snapshot).map((action) => action.label);

describe("pod runtime state", () => {
  it("replaces the list on a snapshot and folds later changes into it", () => {
    let state = reducePodRuntimeEvent(EMPTY_POD_RUNTIME_STATE, {
      type: "snapshot",
      enabled: true,
      pods: [pod("running")],
    });
    state = reducePodRuntimeEvent(state, { type: "upsert", pod: pod("stopping") });
    state = reducePodRuntimeEvent(state, {
      type: "upsert",
      pod: pod("creating", undefined, "pod-two"),
    });
    expect(state.pods.map((entry) => [entry.id, entry.state])).toEqual([
      ["pod-one", "stopping"],
      ["pod-two", "creating"],
    ]);
    state = reducePodRuntimeEvent(state, { type: "upsert", pod: pod("removed") });
    expect(state).toEqual({ enabled: true, pods: [pod("creating", undefined, "pod-two")] });
  });

  it("finds a worktree's pod by its path", () => {
    const pods = [pod("running")];
    expect(podForWorktree(pods, "/work/trees/feature/")?.id).toBe("pod-one");
    expect(podForWorktree(pods, "/work/trees/feature-two")).toBeUndefined();
    expect(podForWorktree(pods, null)).toBeUndefined();
  });
});

describe("pod runtime actions", () => {
  it("pairs every way in with its way out", () => {
    expect(labels(pod("running"))).toEqual([
      "Open pod shell",
      "Stop pod",
      "Recreate pod",
      "Recreate agent container",
      "Remove pod",
    ]);
    expect(labels(pod("stopped"))).toEqual([
      "Start pod",
      "Recreate pod",
      "Recreate agent container",
      "Remove pod",
    ]);
    expect(labels(pod("frozen"))).toContain("Start pod");
  });

  it("offers Retry of the failed operation first in each failure state", () => {
    expect(podRuntimeActions(pod("start_failed", "create"))[0]).toMatchObject({
      label: "Retry",
      request: "start",
    });
    expect(podRuntimeActions(pod("stop_failed", "stop"))[0]).toMatchObject({
      label: "Retry",
      request: "stop",
    });
    expect(labels(pod("start_failed", "start"))).not.toContain("Start pod");
  });

  it("opens the shell of a failed pod, whose agent container may still run", () => {
    expect(labels(pod("start_failed", "start"))).toContain("Open pod shell");
    expect(labels(pod("stop_failed", "stop"))).toContain("Open pod shell");
    expect(labels(pod("stopped"))).not.toContain("Open pod shell");
  });

  it("gives a failed pod's banner Retry, its shell and Recreate, and nothing to a healthy pod", () => {
    expect(podFailureActions(pod("start_failed", "start"))).toEqual([
      { kind: "request", request: "start", label: "Retry", destructive: false },
      { kind: "openShell", label: "Open pod shell" },
      { kind: "request", request: "recreate", label: "Recreate pod", destructive: true },
    ]);
    expect(podFailureActions(pod("stop_failed", "stop"))?.[0]).toMatchObject({ request: "stop" });
    expect(podFailureActions(pod("running"))).toBeNull();
    expect(podFailureActions(pod("stopped"))).toBeNull();
  });

  it("says why a pod is stopped when its threads parked it", () => {
    expect(podRuntimeTitle({ ...pod("stopped"), parked: true })).toBe(
      "Pod stopped while its threads are snoozed or settled; it starts when one wakes",
    );
    expect(podRuntimeTitle(pod("stopped"))).toBe("Pod stopped");
    expect(podRuntimeTitle(pod("start_failed", "start"))).toBe("Pod failed to start: boom");
  });

  it("offers Remove anyway once a removal was refused", () => {
    expect(podRuntimeActions(pod("stop_failed", "remove"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Retry", request: "remove" }),
        expect.objectContaining({ label: "Remove anyway", request: "remove", force: true }),
      ]),
    );
    expect(labels(pod("stop_failed", "stop"))).not.toContain("Remove anyway");
  });

  it("marks only data-losing requests destructive and offers nothing mid-transition but Remove", () => {
    const destructive = podRuntimeActions(pod("running"))
      .filter((action) => action.kind === "request" && action.destructive)
      .map((action) => action.label);
    expect(destructive).toEqual(["Recreate pod", "Remove pod"]);
    for (const state of ["creating", "starting", "stopping"] as const)
      expect(labels(pod(state))).toEqual(["Remove pod"]);
    expect(labels(pod("removing"))).toEqual([]);
  });
});

describe("pod service links", () => {
  const environmentId = EnvironmentId.make("env-1");
  const thread = (
    id: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ): EnvironmentThreadShell =>
    ({
      environmentId,
      id,
      worktreePath: "/work/trees/feature",
      archivedAt: null,
      updatedAt: "2026-10-21T10:00:00.000Z",
      ...overrides,
    }) as EnvironmentThreadShell;

  it("offers only the services published while the pod runs", () => {
    const running: PodRuntimeSnapshot = {
      ...pod("running"),
      services: [
        { name: "web", port: 3000, url: "http://127.0.0.1:20000" },
        { name: "api", port: 8000, url: null },
      ],
    };
    expect(podServiceLinks(running)).toEqual([{ name: "web", url: "http://127.0.0.1:20000" }]);
  });

  it("opens them in the latest live thread on the pod's worktree in its environment", () => {
    const threads = [
      thread("older", { updatedAt: "2026-10-21T09:00:00.000Z" }),
      thread("latest", { worktreePath: "/work/trees/feature/" }),
      thread("archived", { updatedAt: "2026-10-21T11:00:00.000Z", archivedAt: "t" }),
      thread("elsewhere", { updatedAt: "2026-10-21T11:00:00.000Z", worktreePath: "/work/other" }),
      thread("other-env", {
        updatedAt: "2026-10-21T11:00:00.000Z",
        environmentId: EnvironmentId.make("env-2"),
      }),
    ];
    expect(podBrowsingThread(threads, environmentId, pod("running"))?.id).toBe("latest");
    expect(podBrowsingThread([], environmentId, pod("running"))).toBeUndefined();
  });
});
