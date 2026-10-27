/**
 * The Orchestration view's stats strip: active agents, trailing burn and host
 * headroom. Burn comes from an in-memory window of terminal provider turns, so
 * it never scans stored turns and reads `warming` for the first window after a
 * start. Sampling runs only while someone subscribes, and subscribers hear
 * only changes to a verdict, a count or a burn rounded to two figures.
 *
 * @module OrchestrationStatsService
 */
import type {
  HostResourcesSnapshot,
  OrchestrationBurnRate,
  OrchestrationStatsSnapshot,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ProviderTurnId,
  ThreadId,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { hostHeadroom, hostPressure, hostResourceVerdicts } from "@t3tools/shared/hostHeadroom";
import {
  classifyOrchestration,
  orchestrationParentThreadId,
  type OrchestrationDotInput,
  type OrchestrationRow,
} from "@t3tools/shared/orchestrationTree";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { forkParked } from "../serverActivation.ts";
import * as UsageService from "../usage/UsageService.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

type ProviderTurnEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "provider-turn.updated" }
>;

const WINDOW_MINUTES = 10;
const WINDOW_MS = WINDOW_MINUTES * 60_000;
const HOST_INTERVAL = "15 seconds";
const BURN_INTERVAL = "60 seconds";

const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

interface BurnEntry {
  readonly atMs: number;
  readonly threadId: ThreadId;
  readonly tokens: number;
  /** Priced once on arrival; null when the model is unknown or unpriced. */
  readonly usd: number | null;
  /** The provider reported partial or no usage. */
  readonly partial: boolean;
  readonly reportedUsage: boolean;
}

export class OrchestrationStatsService extends Context.Service<
  OrchestrationStatsService,
  {
    /** The current snapshot, sampled now when nobody is subscribed. */
    readonly read: Effect.Effect<OrchestrationStatsSnapshot>;
    /** The current snapshot first, then changes only. */
    readonly subscribe: Stream.Stream<OrchestrationStatsSnapshot>;
  }
>()("t3/orchestrationStats/OrchestrationStatsService") {}

const INITIAL_SNAPSHOT: OrchestrationStatsSnapshot = {
  activeAgents: { runningTurns: 0, liveSessions: 0, idleSessions: 0 },
  burn: {
    state: "warming",
    tokensPerMinute: 0,
    usdPerHour: 0,
    approximate: false,
    perMeta: {},
    perSlice: {},
  },
  host: { verdict: "unknown", cpu: null, ram: null, swap: null, load: null },
};

const roundBurn = (value: number) => (value > 0 ? Number(value.toPrecision(2)) : 0);

const burnRate = (tokens: number, usd: number): OrchestrationBurnRate => ({
  tokensPerMinute: roundBurn(tokens / WINDOW_MINUTES),
  usdPerHour: roundBurn(usd * (60 / WINDOW_MINUTES)),
});

/** Burn values are already rounded, so equal significant fields mean nothing to push. */
const significant = (snapshot: OrchestrationStatsSnapshot) =>
  JSON.stringify([
    snapshot.activeAgents,
    snapshot.burn,
    snapshot.host.verdict,
    hostResourceVerdicts(snapshot.host),
  ]);

/** `inputTokens` includes cache reads and writes; `outputTokens` includes reasoning. */
function turnTotals(usage: NonNullable<ProviderTurnEvent["payload"]["turnTokenUsage"]>) {
  const input = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, input - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
  return { totals, tokens: input + outputTokens, partial: usage.usageStatus !== "complete" };
}

// The classifier also resolves dots; burn attribution reads only its placement.
const NEUTRAL_STATUS: OrchestrationDotInput = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  runtimeStatus: null,
  latestRun: null,
  lastErrorClass: null,
  wokeAt: null,
  backgroundWorkHoldsCompletion: false,
  lastVisitedAt: null,
  settled: false,
  snoozed: false,
  limitParked: false,
  environmentConnected: true,
  shellStatus: "live",
};

/** Maps a thread to its meta (the classifier's tree) and its nearest slice, itself included. */
function burnAttribution(shells: ReadonlyArray<OrchestrationV2ThreadShell>) {
  const parentById = new Map<string, string | null>();
  const metaIds = new Set<string>();
  const classification = classifyOrchestration(
    shells.map((shell) => {
      const parentKey = orchestrationParentThreadId(shell.lineage);
      parentById.set(shell.id, parentKey);
      if (shell.metaAt != null) metaIds.add(shell.id);
      return {
        key: shell.id,
        parentKey,
        projectId: shell.projectId,
        branch: shell.branch,
        rolePresetId: shell.rolePreset?.id ?? null,
        metaAt: shell.metaAt == null ? null : DateTime.formatIso(shell.metaAt),
        archived: shell.archivedAt !== null,
        createdAt: DateTime.formatIso(shell.createdAt),
        status: NEUTRAL_STATUS,
      };
    }),
  );
  const sliceIds = new Set<string>();
  const collect = (rows: ReadonlyArray<OrchestrationRow>) => {
    for (const row of rows) if (row.kind === "slice") sliceIds.add(row.key);
  };
  for (const tree of [classification.noMeta, ...Object.values(classification.trees)]) {
    for (const project of tree.projects)
      for (const branch of project.branches) collect(branch.rows);
  }
  return (threadId: ThreadId) => {
    let slice: ThreadId | null = null;
    const walked = new Set<string>();
    for (
      let key: string | null | undefined = threadId;
      key != null && !walked.has(key) && !metaIds.has(key);
      key = parentById.get(key)
    ) {
      walked.add(key);
      if (sliceIds.has(key)) {
        slice = key as ThreadId;
        break;
      }
    }
    const meta = classification.treeKeyByThreadKey[threadId] ?? null;
    return { meta: meta as ThreadId | null, slice };
  };
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const usage = yield* UsageService.UsageService;
  const hostResources = yield* HostResources.HostResources;
  const scope = yield* Effect.scope;

  const startedAtMs = yield* Clock.currentTimeMillis;
  // Keyed by provider turn: ingestion and recovery can re-emit a terminal turn.
  const window = new Map<ProviderTurnId, BurnEntry>();
  const prune = (nowMs: number) => {
    for (const [id, entry] of window) if (nowMs - entry.atMs > WINDOW_MS) window.delete(id);
  };

  const latest = yield* Ref.make(INITIAL_SNAPSHOT);
  const changes = yield* PubSub.sliding<OrchestrationStatsSnapshot>(1);
  const publishLock = yield* Semaphore.make(1);
  let previousHost: HostResourcesSnapshot | null = null;
  let lastHost: HostResourcesSnapshot | null = null;

  const update = (next: (current: OrchestrationStatsSnapshot) => OrchestrationStatsSnapshot) =>
    publishLock.withPermits(1)(
      Effect.gen(function* () {
        const changed = yield* Ref.modify(latest, (current) => {
          const updated = next(current);
          return [significant(current) !== significant(updated), updated] as const;
        });
        if (changed) yield* PubSub.publish(changes, yield* Ref.get(latest));
      }),
    );

  const onProviderTurn = (event: ProviderTurnEvent) =>
    Effect.gen(function* () {
      const turn = event.payload;
      if (!TERMINAL_TURN_STATUSES.has(turn.status)) return;
      // A later update may add the usage a first terminal update lacked.
      const seen = window.get(turn.id);
      if (seen !== undefined && (seen.reportedUsage || turn.turnTokenUsage === undefined)) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const atMs = DateTime.toEpochMillis(turn.completedAt ?? event.occurredAt);
      if (nowMs - atMs > WINDOW_MS) return;
      prune(nowMs);
      // Only some adapters report usage; a turn without it still makes the burn a lower bound.
      if (turn.turnTokenUsage === undefined) {
        window.set(turn.id, {
          atMs,
          threadId: event.threadId,
          tokens: 0,
          usd: null,
          partial: true,
          reportedUsage: false,
        });
        return;
      }
      // Turns carry no model; their run does.
      const runs = yield* orchestrator
        .getThreadRecords(
          event.threadId,
          ["runs"],
          event.runId === undefined ? undefined : { runIds: [event.runId] },
        )
        .pipe(
          Effect.map((records) => records.runs),
          Effect.orElseSucceed(() => []),
        );
      const run =
        event.runId === undefined
          ? runs.find(
              (candidate) =>
                turn.runAttemptId !== null && candidate.activeAttemptId === turn.runAttemptId,
            )
          : runs.find((candidate) => candidate.id === event.runId);
      const { totals, tokens, partial } = turnTotals(turn.turnTokenUsage);
      const model = run?.modelSelection.model ?? null;
      // Priced per turn, not over summed totals: tiered rates depend on each request's size.
      const usd = model === null ? null : yield* usage.priceTokens(model, totals);
      window.set(turn.id, {
        atMs,
        threadId: event.threadId,
        tokens,
        usd,
        partial,
        reportedUsage: true,
      });
    }).pipe(Effect.ignoreCause);

  const sampleHost = Effect.gen(function* () {
    const host = yield* hostResources.read;
    const counts = yield* providerSessions.sessionCounts;
    // Reads inside HostResources' cache window return the same sample.
    if (lastHost === null || host.sampledAt !== lastHost.sampledAt) {
      previousHost = lastHost;
      lastHost = host;
    }
    const verdict = hostHeadroom(host, previousHost);
    const pressure = hostPressure(host);
    yield* update((current) => ({
      ...current,
      activeAgents: {
        runningTurns: counts.busy,
        liveSessions: counts.live,
        idleSessions: Math.max(0, counts.live - counts.busy),
      },
      host: { verdict, ...pressure },
    }));
  });

  const sampleBurn = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    prune(nowMs);
    const shells = yield* orchestrator.getShellSnapshot({ location: "active" }).pipe(
      Effect.map((snapshot) => snapshot.threads),
      Effect.orElseSucceed(() => null),
    );
    const attribute = shells === null ? null : burnAttribution(shells);
    let tokens = 0;
    let usd = 0;
    let approximate = false;
    const perMeta = new Map<ThreadId, { tokens: number; usd: number }>();
    const perSlice = new Map<ThreadId, { tokens: number; usd: number }>();
    const add = (
      totals: Map<ThreadId, { tokens: number; usd: number }>,
      key: ThreadId | null,
      entryTokens: number,
      entryUsd: number,
    ) => {
      if (key === null) return;
      const sum = totals.get(key) ?? { tokens: 0, usd: 0 };
      totals.set(key, { tokens: sum.tokens + entryTokens, usd: sum.usd + entryUsd });
    };
    for (const entry of window.values()) {
      if (entry.usd === null || entry.partial) approximate = true;
      const entryUsd = entry.usd ?? 0;
      tokens += entry.tokens;
      usd += entryUsd;
      if (attribute !== null) {
        const { meta, slice } = attribute(entry.threadId);
        add(perMeta, meta, entry.tokens, entryUsd);
        add(perSlice, slice, entry.tokens, entryUsd);
      }
    }
    const rates = (totals: Map<ThreadId, { tokens: number; usd: number }>) =>
      Object.fromEntries(
        [...totals]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, sum]) => [key, burnRate(sum.tokens, sum.usd)]),
      );
    const overall = burnRate(tokens, usd);
    yield* update((current) => ({
      ...current,
      burn: {
        state: nowMs - startedAtMs >= WINDOW_MS ? "ready" : "warming",
        ...overall,
        approximate,
        perMeta: rates(perMeta),
        perSlice: rates(perSlice),
      },
    }));
  });

  const sampleAll = Effect.andThen(sampleHost, sampleBurn);
  const sampling = Effect.all(
    [
      Effect.sleep(HOST_INTERVAL).pipe(Effect.andThen(sampleHost), Effect.forever),
      Effect.sleep(BURN_INTERVAL).pipe(Effect.andThen(sampleBurn), Effect.forever),
    ],
    { concurrency: "unbounded", discard: true },
  );

  const subscribers = yield* Semaphore.make(1);
  let subscriberCount = 0;
  let sampler: Fiber.Fiber<void> | null = null;
  const acquire = subscribers.withPermits(1)(
    Effect.gen(function* () {
      subscriberCount += 1;
      if (subscriberCount > 1) return;
      yield* sampleAll;
      sampler = yield* Effect.forkIn(sampling, scope);
    }),
  );
  const release = subscribers.withPermits(1)(
    Effect.gen(function* () {
      subscriberCount -= 1;
      if (subscriberCount > 0 || sampler === null) return;
      const running = sampler;
      sampler = null;
      yield* Fiber.interrupt(running);
      // CPU needs two consecutive samples; samples on either side of a gap are not.
      previousHost = null;
      lastHost = null;
    }),
  );

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "provider-turn.updated" ? onProviderTurn(event) : Effect.void,
    ).pipe(
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration stats event stream failed", { cause }),
      ),
    ),
  );

  return OrchestrationStatsService.of({
    read: subscribers.withPermits(1)(
      Effect.gen(function* () {
        if (subscriberCount === 0) yield* sampleAll;
        return yield* Ref.get(latest);
      }),
    ),
    subscribe: Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(acquire, () => release);
        const { latest: current, changes: next } = yield* subscribeBeforeSnapshot(
          changes,
          Ref.get(latest),
          publishLock,
        );
        return Stream.concat(Stream.make(current), next);
      }),
    ),
  });
});

export const layer = Layer.effect(OrchestrationStatsService, make);
