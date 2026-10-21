import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, PodRuntimeId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ContainerDriver from "./ContainerDriver.ts";
import * as PodRuntimeStore from "./PodRuntimeStore.ts";
import { makeFakeContainerDriver } from "./testkit/FakeContainerDriver.ts";
import * as WorkspaceExecutionTarget from "./WorkspaceExecutionTarget.ts";

const podId = PodRuntimeId.make("pod-target1");

const layer = WorkspaceExecutionTarget.layer.pipe(
  Layer.provideMerge(PodRuntimeStore.layer),
  Layer.provide(Layer.succeed(ContainerDriver.ContainerDriver, makeFakeContainerDriver().driver)),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-test")),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const recordPod = Effect.gen(function* () {
  const store = yield* PodRuntimeStore.PodRuntimeStore;
  yield* store.commit(podId, [
    {
      type: "pod.created",
      podId,
      occurredAt: "2026-10-21T00:00:00.000Z",
      projectId: ProjectId.make("project-1"),
      worktreePath: "/work/trees/feature",
      image: "image",
      dockerHost: "",
      services: [],
    },
  ]);
  return store;
});

describe("WorkspaceExecutionTarget", () => {
  it.effect("runs a pod's worktree and everything under it in the pod, the rest on the host", () =>
    Effect.gen(function* () {
      yield* recordPod;
      const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
      expect(yield* targets.resolve("/work/trees/feature")).toMatchObject({ type: "pod", podId });
      expect(yield* targets.resolve("/work/trees/feature/apps/web")).toMatchObject({
        type: "pod",
      });
      expect(yield* targets.resolve("/work/trees/feature-two")).toEqual({ type: "host" });
      expect(yield* targets.resolve("/work/trees")).toEqual({ type: "host" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("goes back to the host once the pod is removed", () =>
    Effect.gen(function* () {
      const store = yield* recordPod;
      yield* store.commit(podId, [
        {
          type: "pod.operation-requested",
          podId,
          occurredAt: "2026-10-21T00:00:01.000Z",
          operation: "remove",
        },
        {
          type: "pod.operation-succeeded",
          podId,
          occurredAt: "2026-10-21T00:00:02.000Z",
          operation: "remove",
          containerIds: [],
          volumeIds: [],
        },
      ]);
      const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
      expect(yield* targets.resolve("/work/trees/feature")).toEqual({ type: "host" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("passes the host's own credentials into no pod command", () =>
    Effect.gen(function* () {
      yield* recordPod;
      const targets = yield* WorkspaceExecutionTarget.WorkspaceExecutionTarget;
      const target = yield* targets.resolve("/work/trees/feature");
      if (target.type !== "pod") return expect.unreachable();
      const launch = targets.launch(target, {
        command: ["sh"],
        cwd: "/work/trees/feature",
        env: { TERM: "xterm", ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
        tty: true,
      });
      expect(launch.env).toEqual({ TERM: "xterm" });
      expect(launch.args).toContain(`t3-envtest-${podId}-agent`);
      // A provider instance's own env, as Pi, Grok and ACP Registry get it, keeps a key the user set.
      const instance = targets.launch(target, {
        command: ["pi"],
        env: { ANTHROPIC_API_KEY: "sk-ant-instance" },
        tty: false,
        instanceCredentials: true,
      });
      expect(instance.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-instance" });
    }).pipe(Effect.provide(layer)),
  );
});
