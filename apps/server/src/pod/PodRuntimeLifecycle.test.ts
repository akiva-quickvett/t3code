import { describe, expect, it } from "@effect/vitest";
import {
  type PodRuntimeOperation,
  PodRuntimeId,
  type PodRuntimeState,
  PodRuntimeState as PodRuntimeStateSchema,
  ProjectId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import {
  applyPodEvent,
  podHoldsWorktree,
  isPodTransitional,
  planPodCompletion,
  planPodObservation,
  planPodRequest,
  POD_OPERATION_RULES,
  type PodObservation,
  type PodRuntimeEvent,
  type PodRuntimeRecord,
} from "./PodRuntimeLifecycle.ts";

const podId = PodRuntimeId.make("pod-abc123");
const at = "2026-10-21T00:00:00.000Z";
const created = applyPodEvent(undefined, {
  type: "pod.created",
  podId,
  occurredAt: at,
  projectId: ProjectId.make("project-1"),
  worktreePath: "/work/tree",
  image: "image",
  dockerHost: "",
  services: [{ name: "web", port: 3000 }],
})!;

const inState = (state: PodRuntimeState, lastOperation: PodRuntimeOperation = "start") => ({
  ...created,
  snapshot: {
    ...created.snapshot,
    state,
    lastError:
      state === "start_failed" || state === "stop_failed"
        ? { operation: lastOperation, message: "boom", at }
        : null,
  },
});

const ALL_STATES = PodRuntimeStateSchema.literals;
const REQUESTS = ["start", "stop", "recreate", "recreateAgentContainer", "remove"] as const;

const request = (record: PodRuntimeRecord, operation: (typeof REQUESTS)[number]) =>
  planPodRequest(record, operation, at);

const settleRequest = (
  record: PodRuntimeRecord,
  operation: (typeof REQUESTS)[number],
  outcome: "succeeded" | "failed",
) => {
  const planned = request(record, operation);
  if (Result.isFailure(planned) || planned.success.type === "none") return record;
  const requested = applyPodEvent(record, planned.success.event)!;
  const event = planPodCompletion(
    requested,
    (planned.success.event as Extract<PodRuntimeEvent, { type: "pod.operation-requested" }>)
      .operation,
    outcome === "succeeded"
      ? { type: "succeeded", containerIds: ["c1", "c2"], volumeIds: ["v1"] }
      : { type: "failed", message: "boom" },
    at,
  );
  return applyPodEvent(requested, event!)!;
};

describe("pod lifecycle", () => {
  it("starts a new pod in creating, which counts as live", () => {
    expect(created.snapshot.state).toBe("creating");
    expect(created.snapshot.services).toEqual([{ name: "web", port: 3000, url: null }]);
    expect(podHoldsWorktree("creating")).toBe(true);
  });

  it("leaves every failure and settled state through some request", () => {
    for (const state of ["start_failed", "stop_failed", "stopped", "running", "frozen"] as const) {
      const exits = REQUESTS.filter((operation) => {
        const planned = request(inState(state), operation);
        return Result.isSuccess(planned) && planned.success.type === "request";
      });
      expect(exits.length, state).toBeGreaterThan(0);
    }
  });

  it("has a reverse for each way in: Stop and Start, failure and Retry", () => {
    const running = settleRequest(inState("stopped"), "start", "succeeded");
    expect(running.snapshot.state).toBe("running");
    expect(running.snapshot.startedAt).toBe(at);
    const stopped = settleRequest(running, "stop", "succeeded");
    expect(stopped.snapshot.state).toBe("stopped");
    expect(stopped.snapshot.startedAt).toBeNull();

    const failedStart = settleRequest(stopped, "start", "failed");
    expect(failedStart.snapshot).toMatchObject({
      state: "start_failed",
      lastError: { operation: "start", message: "boom" },
    });
    expect(settleRequest(failedStart, "start", "succeeded").snapshot).toMatchObject({
      state: "running",
      lastError: null,
    });

    const failedStop = settleRequest(running, "stop", "failed");
    expect(failedStop.snapshot.state).toBe("stop_failed");
    expect(settleRequest(failedStop, "stop", "succeeded").snapshot.state).toBe("stopped");
    expect(settleRequest(failedStop, "start", "succeeded").snapshot.state).toBe("running");

    const failedRemove = settleRequest(running, "remove", "failed");
    expect(failedRemove.snapshot).toMatchObject({
      state: "stop_failed",
      lastError: { operation: "remove" },
    });
    expect(settleRequest(failedRemove, "remove", "succeeded").snapshot.state).toBe("removed");
  });

  it("retries a failed creation as a creation, so the stack's up and seeds run", () => {
    const planned = request(inState("start_failed", "create"), "start");
    expect(Result.isSuccess(planned) && planned.success).toMatchObject({
      type: "request",
      event: { operation: "create" },
    });
    const restart = request(inState("start_failed", "start"), "start");
    expect(Result.isSuccess(restart) && restart.success).toMatchObject({
      event: { operation: "start" },
    });
  });

  it("answers a request the pod already satisfies without new work", () => {
    for (const [state, operation] of [
      ["running", "start"],
      ["starting", "start"],
      ["stopped", "stop"],
      ["removing", "remove"],
    ] as const) {
      const planned = request(inState(state), operation);
      expect(Result.isSuccess(planned) && planned.success.type, `${state} ${operation}`).toBe(
        "none",
      );
    }
  });

  it("refuses requests the state does not allow", () => {
    for (const [state, operation] of [
      ["creating", "stop"],
      ["stopping", "start"],
      ["removed", "start"],
      ["frozen", "recreateAgentContainer"],
    ] as const) {
      const planned = request(inState(state), operation);
      expect(Result.isFailure(planned) && planned.failure.reason, `${state} ${operation}`).toBe(
        "invalid-state",
      );
    }
  });

  it("drops a completion that a later request overtook", () => {
    const starting = applyPodEvent(inState("stopped"), {
      type: "pod.operation-requested",
      podId,
      occurredAt: at,
      operation: "start",
    })!;
    const planned = request(starting, "remove");
    const removing = applyPodEvent(
      starting,
      (Result.isSuccess(planned) && planned.success.type === "request"
        ? planned.success.event
        : undefined)!,
    )!;
    expect(removing.snapshot.state).toBe("removing");
    expect(
      planPodCompletion(
        removing,
        "start",
        { type: "succeeded", containerIds: [], volumeIds: [] },
        at,
      ),
    ).toBeNull();
  });

  it("records a forced removal as removed", () => {
    const removing = applyPodEvent(inState("stop_failed", "remove"), {
      type: "pod.operation-requested",
      podId,
      occurredAt: at,
      operation: "remove",
    })!;
    const event = planPodCompletion(
      removing,
      "remove",
      { type: "succeeded", containerIds: [], volumeIds: [], forced: true },
      at,
    )!;
    expect(event).toMatchObject({ forced: true });
    expect(applyPodEvent(removing, event)!.snapshot.state).toBe("removed");
  });

  it("keeps every transitional state pending in exactly one operation's rule", () => {
    for (const state of ALL_STATES.filter(isPodTransitional)) {
      const pendingFor = Object.values(POD_OPERATION_RULES).filter(
        (rule) => rule.pending === state,
      );
      expect(pendingFor.length, state).toBeGreaterThan(0);
    }
  });
});

describe("pod reconcile", () => {
  const observation = (overrides: Partial<PodObservation>): PodObservation => ({
    containerIds: ["c1", "c2"],
    volumeIds: ["v1"],
    running: false,
    paused: false,
    halted: true,
    ...overrides,
  });

  it("lands an operation cut off by a restart where its Retry finishes it", () => {
    expect(
      planPodObservation(inState("creating"), observation({ running: true, halted: false }), at),
    ).toMatchObject({ state: "start_failed", failedOperation: "create" });
    expect(
      planPodObservation(inState("starting"), observation({ running: true, halted: false }), at),
    ).toMatchObject({ state: "running", failedOperation: null });
    expect(planPodObservation(inState("starting"), observation({}), at)).toMatchObject({
      state: "start_failed",
      failedOperation: "start",
    });
    expect(planPodObservation(inState("stopping"), observation({}), at)).toMatchObject({
      state: "stopped",
    });
    expect(
      planPodObservation(inState("removing"), observation({ containerIds: [], volumeIds: [] }), at),
    ).toMatchObject({ state: "removed" });
    expect(planPodObservation(inState("removing"), observation({}), at)).toMatchObject({
      state: "stop_failed",
      failedOperation: "remove",
    });
  });

  it("follows Docker for settled states and leaves failures to the user", () => {
    expect(planPodObservation(inState("running"), observation({}), at)).toMatchObject({
      state: "stopped",
    });
    expect(
      planPodObservation(inState("running"), observation({ paused: true, halted: false }), at),
    ).toMatchObject({ state: "frozen" });
    expect(
      planPodObservation(inState("running"), observation({ running: true, halted: false }), at),
    ).toBeNull();
    expect(planPodObservation(inState("start_failed"), observation({}), at)).toBeNull();
    expect(planPodObservation(inState("stop_failed"), observation({}), at)).toBeNull();
  });

  it("keeps a partly running pod in a failure state that still holds its worktree", () => {
    const partly = observation({ halted: false });
    const fromRunning = planPodObservation(inState("running"), partly, at);
    expect(fromRunning).toMatchObject({ state: "start_failed", failedOperation: "start" });
    const fromStopped = planPodObservation(inState("stopped"), partly, at);
    expect(fromStopped).toMatchObject({ state: "stop_failed", failedOperation: "stop" });
    for (const event of [fromRunning, fromStopped])
      expect(podHoldsWorktree(applyPodEvent(inState("running"), event!)!.snapshot.state)).toBe(
        true,
      );
    expect(podHoldsWorktree("stopped")).toBe(false);
  });

  it("retries a pod whose containers vanished as a creation", () => {
    const gone = observation({ containerIds: [], volumeIds: [] });
    for (const state of ["running", "stopped", "frozen"] as const)
      expect(planPodObservation(inState(state), gone, at)).toMatchObject({
        state: "start_failed",
        failedOperation: "create",
      });
  });
});

describe("pod requests and the agent container", () => {
  const probed = {
    ...inState("running"),
    snapshot: { ...inState("running").snapshot, mcpListener: "blocked" as const },
  };
  const requested = (
    operation: PodRuntimeOperation,
    image?: string,
  ): Extract<PodRuntimeEvent, { type: "pod.operation-requested" }> => ({
    type: "pod.operation-requested",
    podId,
    occurredAt: at,
    operation,
    ...(image === undefined ? {} : { image }),
  });

  it("keeps the listener probe through an agent-container recreate, and drops it otherwise", () => {
    expect(applyPodEvent(probed, requested("recreateAgentContainer"))?.snapshot.mcpListener).toBe(
      "blocked",
    );
    expect(applyPodEvent(probed, requested("stop"))?.snapshot).not.toHaveProperty("mcpListener");
  });

  it("records the image a recreate makes its agent container from", () => {
    expect(
      applyPodEvent(probed, requested("recreate", "t3.invalid/pod-agent"))?.snapshot.image,
    ).toBe("t3.invalid/pod-agent");
    expect(applyPodEvent(probed, requested("start"))?.snapshot.image).toBe("image");
  });
});
