import {
  CommandId,
  PULL_REQUEST_AGENT_STATES,
  pullRequestAgentLabelsProblem,
  type PullRequestAgentLabels,
  type PullRequestSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { deriveAgentState, workTreeOf, type WorkTreeNode } from "./pullRequestAgentState.ts";

/** A failed write is tried again after this long rather than on every sweep. */
const FAILED_WRITE_RETRY_MS = 15 * 60 * 1_000;

export interface PullRequestLabelObservation {
  /** A fresh read of the pull request, whose labels the change is diffed against. */
  readonly summary: PullRequestSummary;
  readonly entries: ReadonlyArray<{
    readonly thread: ProjectionStore.ProjectionThreadPullRequests;
    readonly link: ThreadPullRequestLink;
  }>;
}

export interface AgentLabelChange {
  readonly add: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}

/**
 * Rules own exactly the five configured names: the one for this state is added, the other four
 * are removed as the pull request spells them, and every other label is left alone.
 */
export function agentLabelChange(
  labels: PullRequestAgentLabels,
  state: (typeof PULL_REQUEST_AGENT_STATES)[number],
  current: ReadonlyArray<string>,
): AgentLabelChange {
  const wanted = labels[state];
  const owned = new Set(
    PULL_REQUEST_AGENT_STATES.filter((other) => other !== state).map((other) =>
      labels[other].toLowerCase(),
    ),
  );
  return {
    add: current.some((name) => name.toLowerCase() === wanted.toLowerCase()) ? [] : [wanted],
    remove: current.filter((name) => owned.has(name.toLowerCase())),
  };
}

/**
 * The link whose tree decides the labels, so threads sharing a pull request never take turns
 * setting it: the topmost of the threads that link it, then the earliest link.
 */
function owningEntry(
  entries: PullRequestLabelObservation["entries"],
  nodes: ReadonlyArray<WorkTreeNode>,
): PullRequestLabelObservation["entries"][number] {
  const parentOf = new Map(nodes.map((node) => [node.threadId, node.parentThreadId]));
  const linked = new Set(entries.map((entry) => entry.thread.id));
  const underAnother = (threadId: (typeof entries)[number]["thread"]["id"]) => {
    const seen = new Set([threadId]);
    let parent = parentOf.get(threadId) ?? null;
    while (parent !== null && !seen.has(parent)) {
      if (linked.has(parent)) return true;
      seen.add(parent);
      parent = parentOf.get(parent) ?? null;
    }
    return false;
  };
  const tops = entries.filter((entry) => !underAnother(entry.thread.id));
  return (tops.length > 0 ? tops : entries).toSorted(
    (left, right) =>
      left.link.linkedAt.localeCompare(right.link.linkedAt) ||
      left.thread.id.localeCompare(right.thread.id),
  )[0]!;
}

export class PullRequestLabelReactor extends Context.Service<
  PullRequestLabelReactor,
  {
    /**
     * Applies the label rules to pull requests the sync sweep just read. It reads nothing from
     * the host itself: the sweep's summary carries the labels, so rules add no polling.
     */
    readonly apply: (
      observations: ReadonlyArray<PullRequestLabelObservation>,
    ) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestLabelReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const failedUntil = new Map<string, number>();

  const recordDone = Effect.fn("PullRequestLabelReactor.recordDone")(function* (
    entry: PullRequestLabelObservation["entries"][number],
    nowIso: string,
  ) {
    const uuid = yield* crypto.randomUUIDv4();
    yield* engine.dispatch({
      type: "thread.pull-request-link.agent-done",
      commandId: CommandId.make(`server:pr-agent-done:${entry.thread.id}:${uuid}`),
      threadId: entry.thread.id,
      host: normalizeThreadPullRequestKey(entry.link).host,
      repository: entry.link.repository,
      number: entry.link.number,
      doneAt: nowIso,
    });
  });

  const applyOne = Effect.fn("PullRequestLabelReactor.applyOne")(function* (
    observation: PullRequestLabelObservation,
    labels: PullRequestAgentLabels,
    nodes: ReadonlyArray<WorkTreeNode>,
    nowMs: number,
  ) {
    const { summary } = observation;
    const owner = owningEntry(observation.entries, nodes);
    const key = threadPullRequestKeyOf(owner.link);
    if ((failedUntil.get(key) ?? 0) > nowMs) return;
    const state = deriveAgentState({
      tree: workTreeOf(owner.thread.id, nodes),
      linkedAtMs: Date.parse(owner.link.linkedAt),
      doneBefore: owner.link.agentDoneAt !== undefined,
      nowMs,
    });
    if (state === null) return;
    // Recorded before the labels change, so a failed write cannot lose the first done.
    if (state === "done" && owner.link.agentDoneAt === undefined) {
      yield* recordDone(owner, DateTime.formatIso(DateTime.makeUnsafe(nowMs)));
    }
    const change = agentLabelChange(
      labels,
      state,
      (summary.labels ?? []).map((label) => label.name),
    );
    const ref = {
      projectId: summary.projectId,
      repository: summary.repository,
      number: summary.number,
    };
    const write = Effect.gen(function* () {
      if (change.add.length > 0) {
        yield* pullRequests.setLabels(
          { ...ref, labels: change.add, applied: true },
          { background: true },
        );
      }
      if (change.remove.length > 0) {
        yield* pullRequests.setLabels(
          { ...ref, labels: change.remove, applied: false },
          { background: true },
        );
      }
    });
    yield* write.pipe(
      Effect.tap(() => Effect.sync(() => failedUntil.delete(key))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.sync(() => failedUntil.set(key, nowMs + FAILED_WRITE_RETRY_MS)).pipe(
            Effect.andThen(
              Effect.logWarning("pull request agent labels not applied", {
                key,
                state,
                reason: Cause.pretty(cause),
              }),
            ),
          ),
      ),
    );
  });

  const apply: PullRequestLabelReactor["Service"]["apply"] = (observations) =>
    Effect.gen(function* () {
      if (observations.length === 0) return;
      const settings = yield* settingsService.getSettings;
      const ruled = observations.flatMap((observation) => {
        const { summary } = observation;
        // Merged and closed pull requests keep the label they ended with; a host whose read
        // carries no labels cannot be diffed, so it is never written blind.
        if (summary.state !== "open" || summary.labels === undefined) return [];
        const rules = resolveProjectSettings(settings, summary.projectId).settings
          .pullRequestLabelRules;
        if (!rules.enabled || pullRequestAgentLabelsProblem(rules.labels) !== null) return [];
        return observation.entries.length === 0 ? [] : [{ observation, labels: rules.labels }];
      });
      if (ruled.length === 0) return;
      const nodes = yield* projections.getWorkTreeNodes([
        ...new Set(
          ruled.flatMap(({ observation }) => observation.entries.map((entry) => entry.thread.id)),
        ),
      ]);
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        ruled,
        ({ observation, labels }) =>
          applyOne(observation, labels, nodes, nowMs).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("pull request agent labels skipped", {
                  key: threadPullRequestKeyOf(observation.entries[0]!.link),
                  reason: Cause.pretty(cause),
                }),
            ),
          ),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("pull request agent labels skipped", { reason: Cause.pretty(cause) }),
      ),
    );

  return { apply } satisfies PullRequestLabelReactor["Service"];
});

export const layer = Layer.effect(PullRequestLabelReactor, make);
