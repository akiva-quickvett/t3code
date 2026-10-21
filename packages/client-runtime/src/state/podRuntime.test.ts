import { describe, expect, it } from "@effect/vitest";
import {
  PodRuntimeId,
  type PodRuntimeOperation,
  type PodRuntimeSnapshot,
  type PodRuntimeState,
  ProjectId,
} from "@t3tools/contracts";

import {
  EMPTY_POD_RUNTIME_STATE,
  podForWorktree,
  podRuntimeActions,
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
