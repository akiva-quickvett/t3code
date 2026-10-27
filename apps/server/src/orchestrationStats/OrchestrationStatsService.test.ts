import {
  type HostResourcesSnapshot,
  ProjectId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as OrchestrationStatsService from "./OrchestrationStatsService.ts";

const MINUTE = 60_000;

/** An event for the domain stream, or a barrier the stream opens once everything before it ran. */
type Fed = { readonly event: unknown } | { readonly barrier: Deferred.Deferred<void> };

interface Fixture {
  /** Set when the stats layer is built. */
  events: Queue.Queue<Fed> | null;
  /** Fails the next domain stream subscription, then opens this. */
  failNextSubscription: Deferred.Deferred<void> | null;
  shells: ReadonlyArray<unknown>;
  modelByThread: Map<string, string>;
  host: Omit<HostResourcesSnapshot, "sampledAt">;
  counts: { live: number; busy: number };
  hostReads: number;
}

const makeFixture = (): Fixture => ({
  events: null,
  failNextSubscription: null,
  shells: [],
  modelByThread: new Map(),
  host: {
    cpuUtilization: 0.31,
    cpuCount: 4,
    availableMemoryBytes: 50,
    totalMemoryBytes: 100,
    swapUsedBytes: 0,
    swapTotalBytes: 100,
    loadAverage1m: 1,
  },
  counts: { live: 0, busy: 0 },
  hostReads: 0,
});

const statsLayer = (fixture: Fixture) =>
  Layer.unwrap(
    Effect.map(Queue.unbounded<Fed>(), (events) => {
      fixture.events = events;
      return statsServiceLayer(fixture, events);
    }),
  );

const statsServiceLayer = (fixture: Fixture, events: Queue.Queue<Fed>) =>
  OrchestrationStatsService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.unwrap(
            Effect.sync(() => {
              const failed = fixture.failNextSubscription;
              if (failed !== null) {
                fixture.failNextSubscription = null;
                return Stream.fromEffect(Deferred.succeed(failed, undefined)).pipe(
                  Stream.flatMap(() => Stream.fail("unavailable")),
                );
              }
              // One element at a time, so a barrier opens only after the consumer ran what preceded it.
              return Stream.fromQueue(events).pipe(
                Stream.flatMap((fed) =>
                  "barrier" in fed
                    ? Stream.fromEffect(Deferred.succeed(fed.barrier, undefined)).pipe(Stream.drain)
                    : Stream.make(fed.event),
                ),
              );
            }),
          ) as never,
          getThreadRecords: (threadId, _fields, filter) =>
            Effect.succeed({
              runs: (filter?.runIds ?? []).map((id) => ({
                id,
                modelSelection: { model: fixture.modelByThread.get(threadId) ?? "known" },
              })),
            } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: fixture.shells,
              archivedThreads: [],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          sessionCounts: Effect.sync(() => fixture.counts),
        }),
        Layer.mock(UsageService.UsageService)({
          // $1 per thousand output tokens for the one known model.
          priceTokens: (model, totals) =>
            Effect.succeed(model === "known" ? totals.outputTokens / 1000 : null),
        }),
        Layer.mock(HostResources.HostResources)({
          read: Effect.sync(() => ({ ...fixture.host, sampledAt: ++fixture.hostReads })),
        }),
      ),
    ),
  );

/** Hands events to the service and waits until it has handled them. */
const feed = (fixture: Fixture, ...events: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    if (fixture.events === null) return yield* Effect.die("the stats layer is not built");
    const barrier = yield* Deferred.make<void>();
    yield* Queue.offerAll(fixture.events, [...events.map((event) => ({ event })), { barrier }]);
    yield* Deferred.await(barrier);
  });

const turn = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly atMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly withoutUsage?: boolean;
}) =>
  ({
    type: "provider-turn.updated",
    id: `event-${input.id}`,
    threadId: ThreadId.make(input.threadId),
    runId: RunId.make(`run-${input.id}`),
    occurredAt: DateTime.makeUnsafe(input.atMs),
    payload: {
      id: ProviderTurnId.make(input.id),
      status: "completed",
      runAttemptId: null,
      completedAt: DateTime.makeUnsafe(input.atMs),
      ...(input.withoutUsage
        ? {}
        : {
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              inputTokens: input.inputTokens,
              outputTokens: input.outputTokens,
              hasSubagents: false,
            },
          }),
    },
  }) as never;

const shell = (input: {
  readonly id: string;
  readonly role?: string;
  readonly meta?: boolean;
  readonly supervisor?: string;
  readonly parent?: string;
}) => ({
  id: ThreadId.make(input.id),
  projectId: ProjectId.make("project"),
  branch: null,
  lineage: {
    parentThreadId: input.parent === undefined ? null : ThreadId.make(input.parent),
    relationshipToParent: input.parent === undefined ? null : "subagent",
    rootThreadId: ThreadId.make(input.id),
    ...(input.supervisor === undefined
      ? {}
      : { supervisorThreadId: ThreadId.make(input.supervisor) }),
  },
  rolePreset: input.role === undefined ? null : { id: input.role, label: input.role },
  metaAt: input.meta ? DateTime.makeUnsafe(0) : null,
  archivedAt: null,
  createdAt: DateTime.makeUnsafe(0),
  activeRunId: null,
});

describe("OrchestrationStatsService", () => {
  it.effect("burns tokens per minute over the trailing ten minutes", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      expect((yield* stats.read).burn.state).toBe("warming");

      yield* TestClock.setTime(14 * MINUTE);
      yield* feed(
        fixture,
        turn({ id: "a", threadId: "t", atMs: 14 * MINUTE, inputTokens: 400, outputTokens: 600 }),
      );
      yield* TestClock.setTime(18 * MINUTE);
      const second = turn({
        id: "b",
        threadId: "t",
        atMs: 18 * MINUTE,
        inputTokens: 1000,
        outputTokens: 2000,
      });
      // A re-emitted terminal turn counts once.
      yield* feed(fixture, second, second);

      yield* TestClock.setTime(20 * MINUTE);
      expect((yield* stats.read).burn).toEqual({
        state: "ready",
        tokensPerMinute: 400,
        // $2.60 over ten minutes.
        usdPerHour: 16,
        approximate: false,
        perMeta: {},
        perSlice: {},
      });

      // The first turn is now twelve minutes old.
      yield* TestClock.setTime(26 * MINUTE);
      expect((yield* stats.read).burn).toMatchObject({ tokensPerMinute: 300, usdPerHour: 12 });
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("marks the burn approximate when a model has no price", () => {
    const fixture = makeFixture();
    fixture.modelByThread.set("t", "mystery-model");
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      yield* feed(
        fixture,
        turn({ id: "a", threadId: "t", atMs: 0, inputTokens: 100, outputTokens: 100 }),
      );
      expect((yield* stats.read).burn).toMatchObject({
        approximate: true,
        tokensPerMinute: 20,
        usdPerHour: 0,
      });
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("attributes a cell's turn to its slice and meta", () => {
    const fixture = makeFixture();
    fixture.shells = [
      shell({ id: "meta", meta: true }),
      shell({ id: "slice", role: "slice", supervisor: "meta" }),
      shell({ id: "pod", role: "broker", parent: "slice" }),
      shell({ id: "cell", role: "implementor", parent: "pod" }),
      shell({ id: "loose" }),
    ];
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      yield* feed(
        fixture,
        turn({ id: "a", threadId: "cell", atMs: 0, inputTokens: 500, outputTokens: 500 }),
      );
      yield* feed(
        fixture,
        turn({ id: "b", threadId: "loose", atMs: 0, inputTokens: 1000, outputTokens: 1000 }),
      );
      const { burn } = yield* stats.read;
      expect(burn.tokensPerMinute).toBe(300);
      expect(burn.perMeta).toEqual({ meta: { tokensPerMinute: 100, usdPerHour: 3 } });
      expect(burn.perSlice).toEqual({ slice: { tokensPerMinute: 100, usdPerHour: 3 } });
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("samples only while someone subscribes, and greets each with the snapshot", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      yield* TestClock.adjust("2 minutes");
      expect(fixture.hostReads).toBe(0);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* Stream.toPull(stats.subscribe);
          yield* first;
          expect(fixture.hostReads).toBe(1);
          fixture.counts = { live: 2, busy: 1 };
          yield* TestClock.adjust("15 seconds");
          expect(fixture.hostReads).toBe(2);

          const second = yield* Stream.toPull(stats.subscribe);
          const [greeting] = yield* second;
          expect(greeting).toEqual(yield* stats.read);
          expect(greeting.activeAgents).toEqual({
            runningTurns: 1,
            liveSessions: 2,
            idleSessions: 1,
          });
          // The second subscriber reuses the running sampler.
          expect(fixture.hostReads).toBe(2);
        }),
      );

      yield* TestClock.adjust("2 minutes");
      expect(fixture.hostReads).toBe(2);
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("pushes nothing when a sample moves CPU within the same verdict", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(stats.subscribe);
          const [greeting] = yield* pull;
          expect(greeting.host).toMatchObject({ verdict: "ok", cpu: 0.31 });

          fixture.host = { ...fixture.host, cpuUtilization: 0.33 };
          yield* TestClock.adjust("15 seconds");
          expect((yield* stats.read).host.cpu).toBe(0.33);
          const quiet = yield* pull.pipe(Effect.timeoutOption("1 second"), Effect.forkChild);
          yield* TestClock.adjust("1 second");
          expect(Option.isNone(yield* Fiber.join(quiet))).toBe(true);

          fixture.host = { ...fixture.host, availableMemoryBytes: 10 };
          const pushed = yield* pull.pipe(Effect.forkChild);
          yield* TestClock.adjust("15 seconds");
          const [change] = yield* Fiber.join(pushed);
          expect(change.host).toMatchObject({ verdict: "low", cpu: 0.33 });
        }),
      );
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("marks the burn approximate for a turn its provider reported no usage for", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      yield* feed(
        fixture,
        turn({ id: "a", threadId: "t", atMs: 0, inputTokens: 500, outputTokens: 500 }),
        turn({
          id: "b",
          threadId: "t",
          atMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          withoutUsage: true,
        }),
      );
      expect((yield* stats.read).burn).toMatchObject({
        approximate: true,
        tokensPerMinute: 100,
        usdPerHour: 3,
      });

      // A later update with usage replaces the usage-less record of the same turn.
      yield* feed(
        fixture,
        turn({ id: "b", threadId: "t", atMs: 0, inputTokens: 500, outputTokens: 500 }),
      );
      expect((yield* stats.read).burn).toMatchObject({ approximate: false, tokensPerMinute: 200 });
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("keeps counting turns after the domain event stream fails", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      fixture.failNextSubscription = failed;
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      yield* Deferred.await(failed);
      yield* TestClock.adjust("5 seconds");
      yield* feed(
        fixture,
        turn({ id: "a", threadId: "t", atMs: 0, inputTokens: 500, outputTokens: 500 }),
      );
      expect((yield* stats.read).burn.tokensPerMinute).toBe(100);
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("pushes a resource changing verdict while the overall verdict holds", () => {
    const fixture = makeFixture();
    fixture.host = { ...fixture.host, swapUsedBytes: 95 };
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(stats.subscribe);
          const [greeting] = yield* pull;
          expect(greeting.host.verdict).toBe("exhausted");

          fixture.host = { ...fixture.host, availableMemoryBytes: 10 };
          const pushed = yield* pull.pipe(Effect.forkChild);
          yield* TestClock.adjust("15 seconds");
          const [change] = yield* Fiber.join(pushed);
          expect(change.host).toMatchObject({ verdict: "exhausted", ram: 0.9 });
        }),
      );
    }).pipe(Effect.provide(statsLayer(fixture)));
  });

  it.effect("does not pair CPU samples across a gap with no subscribers", () => {
    const fixture = makeFixture();
    fixture.host = { ...fixture.host, cpuUtilization: 0.95 };
    return Effect.gen(function* () {
      const stats = yield* OrchestrationStatsService.OrchestrationStatsService;
      const greet = Effect.scoped(
        Effect.gen(function* () {
          const [greeting] = yield* yield* Stream.toPull(stats.subscribe);
          return greeting.host.verdict;
        }),
      );
      expect(yield* greet).toBe("ok");
      yield* TestClock.adjust("2 minutes");
      expect(yield* greet).toBe("ok");
    }).pipe(Effect.provide(statsLayer(fixture)));
  });
});
