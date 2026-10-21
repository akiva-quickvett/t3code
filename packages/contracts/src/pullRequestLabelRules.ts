import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The one state a thread's work tree is in, as shown by one label on its pull requests. */
export const PullRequestAgentState = Schema.Literals([
  "investigating",
  "building",
  "reviewing",
  "done",
  "revising",
]);
export type PullRequestAgentState = typeof PullRequestAgentState.Type;

export const PULL_REQUEST_AGENT_STATES = PullRequestAgentState.literals;

/** People set this label by hand to say a pull request is theirs to review; rules never touch it. */
export const READY_FOR_HUMAN_REVIEW_LABEL = "Ready For Human Review";

export const DEFAULT_PULL_REQUEST_AGENT_LABELS: Readonly<Record<PullRequestAgentState, string>> = {
  investigating: "Agent Investigating",
  building: "Agent Building",
  reviewing: "Agent Reviewing",
  done: "Agent Done",
  revising: "Agent Revising",
};

// GitHub's limit on a label name.
const PullRequestLabelName = TrimmedNonEmptyString.check(Schema.isMaxLength(50));

const labelField = (state: PullRequestAgentState) =>
  PullRequestLabelName.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PULL_REQUEST_AGENT_LABELS[state])),
  );

export const PullRequestAgentLabels = Schema.Struct({
  investigating: labelField("investigating"),
  building: labelField("building"),
  reviewing: labelField("reviewing"),
  done: labelField("done"),
  revising: labelField("revising"),
});
export type PullRequestAgentLabels = typeof PullRequestAgentLabels.Type;

/**
 * Why these label names cannot be managed, or null when they can. Rules own exactly the five
 * names, so two states sharing a name, or a name equal to the human review label, would make
 * them remove a label they just added or one they must never touch.
 */
export function pullRequestAgentLabelsProblem(labels: PullRequestAgentLabels): string | null {
  const names = PULL_REQUEST_AGENT_STATES.map((state) => labels[state].trim().toLowerCase());
  if (names.includes(READY_FOR_HUMAN_REVIEW_LABEL.toLowerCase())) {
    return `"${READY_FOR_HUMAN_REVIEW_LABEL}" is set by people and cannot be an agent label.`;
  }
  if (new Set(names).size !== names.length) return "Each state needs its own label name.";
  return null;
}

export const PullRequestLabelRules = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  labels: PullRequestAgentLabels.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PULL_REQUEST_AGENT_LABELS)),
  ),
}).check(Schema.makeFilter((rules) => pullRequestAgentLabelsProblem(rules.labels) ?? true));
export type PullRequestLabelRules = typeof PullRequestLabelRules.Type;

export const DEFAULT_PULL_REQUEST_LABEL_RULES: PullRequestLabelRules = {
  enabled: false,
  labels: DEFAULT_PULL_REQUEST_AGENT_LABELS,
};
