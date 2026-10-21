import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  PodRuntimeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  HOST_PLACEMENT,
  PodProviderPlacement,
  ProviderPodRefusedError,
} from "../provider/PodProviderSessions.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const openCodeId = ProviderInstanceId.make("opencode");
const podId = PodRuntimeId.make("pod-orchestrator1");
const POD_WORKTREE = "/work/trees/pod";
// Codex serves every thread of an instance from one shared session.
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process is needed to choose a session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
// Shares one server per instance too, but cannot run in a pod.
const openCode = {
  ...adapter,
  instanceId: openCodeId,
  driver: ProviderDriverKind.make("opencode"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const placementsAsked: Array<{ readonly driver: string; readonly runsIn: string | undefined }> = [];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "pod-sessions" },
    ProviderAdapterRegistry.layerFromAdapters([adapter, openCode]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provide(
    Layer.succeed(PodProviderPlacement, {
      place: () => Effect.succeed(HOST_PLACEMENT),
      // The real rules: Codex runs in the pod, OpenCode on the host only with runsIn: host.
      podFor: ({ cwd, driver, runsIn }) => {
        placementsAsked.push({ driver, runsIn });
        if (cwd === null || !cwd.startsWith(POD_WORKTREE)) return Effect.succeed(undefined);
        if (driver === "codex") return Effect.succeed(podId);
        return runsIn === "host"
          ? Effect.succeed(undefined)
          : Effect.fail(new ProviderPodRefusedError({ reason: "OpenCode cannot run in a pod." }));
      },
    }),
  ),
);

const providerSessionOf = (
  name: string,
  worktreePath: string | null,
  options: { readonly instance?: ProviderInstanceId; readonly rolePresetId?: string } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(name);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${name}`),
      threadId,
      projectId: ProjectId.make("project:pod-sessions"),
      title: name,
      modelSelection: { instanceId: options.instance ?? instanceId, model: "gpt-5.1-codex" },
      ...(options.rolePresetId === undefined
        ? {}
        : { rolePreset: { id: options.rolePresetId, label: options.rolePresetId } }),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`dispatch-${name}`),
      threadId,
      messageId: MessageId.make(`message-${name}`),
      text: "Start",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    return records.providerThreads.at(-1)?.providerSessionId;
  });

it.effect("gives a pod's threads their own shared session, apart from the host's", () =>
  Effect.gen(function* () {
    const shared = IdAllocator.derive.providerSession({ providerInstanceId: instanceId });
    const podShared = IdAllocator.derive.providerSession({
      providerInstanceId: instanceId,
      scope: podId,
    });
    assert.notEqual(podShared, shared);
    assert.equal(yield* providerSessionOf("thread-host", null), shared);
    assert.equal(yield* providerSessionOf("thread-pod", POD_WORKTREE), podShared);
    assert.equal(yield* providerSessionOf("thread-pod-two", `${POD_WORKTREE}/apps`), podShared);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a host-placed thread of a pod's worktree on the host's shared session", () =>
  Effect.gen(function* () {
    const shared = IdAllocator.derive.providerSession({ providerInstanceId: openCodeId });
    placementsAsked.length = 0;
    // `review-t3-grok` is a seeded preset that runs on the host.
    assert.equal(
      yield* providerSessionOf("thread-opencode-host", POD_WORKTREE, {
        instance: openCodeId,
        rolePresetId: "review-t3-grok",
      }),
      shared,
    );
    // Refused in the pod: it gets the host's id, and opening the session refuses it.
    assert.equal(
      yield* providerSessionOf("thread-opencode-refused", POD_WORKTREE, { instance: openCodeId }),
      shared,
    );
    assert.deepEqual(placementsAsked, [
      { driver: "opencode", runsIn: "host" },
      { driver: "opencode", runsIn: undefined },
    ]);
  }).pipe(Effect.provide(layerTest)),
);
