import {
  type AgentRolePreset,
  type AgentRolePresetTarget,
  ProviderDriverKind,
} from "@t3tools/contracts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");

const claude = (model: string, effort: string): AgentRolePresetTarget => ({
  driverKind: CLAUDE,
  model,
  options: [{ id: "effort", value: effort }],
});

const OPUS_HIGH = claude("claude-opus-5-5", "high");
const OPUS_XHIGH = claude("claude-opus-5-5", "xhigh");
const SONNET_HIGH = claude("claude-sonnet-5-5", "high");
const FABLE_HIGH = claude("claude-fable-5-1", "high");
const GROK_HIGH: AgentRolePresetTarget = {
  driverKind: CURSOR,
  model: "grok-4.7",
  options: [{ id: "effort", value: "high" }],
};

const SKILL = "t3-orchestration";

const preset = (
  id: string,
  label: string,
  target: AgentRolePresetTarget,
  essentials: string,
  extra: Omit<Partial<AgentRolePreset>, "id" | "label" | "target" | "instructions"> = {},
): AgentRolePreset => ({
  id,
  label,
  target,
  instructions: `You are the ${label} (role \`${id}\`). Follow the ${SKILL} skill's section for this role. ${essentials}`,
  skills: [SKILL],
  ...extra,
});

const reviewer = (tier: number, target: AgentRolePresetTarget, extra = {}) =>
  preset(
    `review-t${tier}`,
    `Reviewer (tier ${tier})`,
    target,
    `Review at tier ${tier} and the tiers below it. Never edit code. Reply once per round: each finding with file, line, severity and a concrete fix.`,
    extra,
  );

/**
 * Mirrors orch's role table. The server merges user edits over these, so a
 * change here reaches everyone who never edited the preset.
 */
export const DEFAULT_AGENT_ROLE_PRESETS: ReadonlyArray<AgentRolePreset> = [
  preset(
    "meta",
    "Meta orchestrator",
    OPUS_HIGH,
    "Delegate everything and never edit product code. Start one slice thread per goal and relay results to the user.",
    { allowedChildRoles: ["slice", "ticket"] },
  ),
  preset(
    "slice",
    "Slice orchestrator",
    OPUS_HIGH,
    "Own one goal: its branch, its pull request and the brokers that build it. Never write code yourself.",
    {
      allowedChildRoles: [
        "broker",
        "research",
        "scout",
        "review-t1",
        "review-t2",
        "review-t3",
        "ticket",
      ],
    },
  ),
  preset(
    "broker",
    "Pod broker",
    OPUS_HIGH,
    "Own one feature in one worktree. Delegate the code to an implementor and review at the pod's tier; commit and push the pod branch.",
    {
      isolation: "worktree",
      allowedChildRoles: [
        "implementor",
        "tester",
        "scout",
        "research",
        "review-t1",
        "review-t2",
        "review-t3",
        "review-t3-grok",
        "review-t4",
        "review-t5",
        "governor",
      ],
    },
  ),
  preset(
    "implementor",
    "Implementor",
    OPUS_HIGH,
    "Write the code for your parent's task in the shared checkout. Do not commit. Report once what you changed and what you ran.",
    { isolation: "shared" },
  ),
  preset(
    "tester",
    "Tester",
    OPUS_HIGH,
    "Write only the tests you were asked for. Change product code only as far as a test needs.",
    { isolation: "shared" },
  ),
  preset(
    "scout",
    "Scout",
    SONNET_HIGH,
    "Do the context-heavy work (browsing, test and lint runs, integration checks) and return distilled results, not raw dumps.",
    { isolation: "shared" },
  ),
  preset(
    "research",
    "Researcher",
    SONNET_HIGH,
    "Investigate approaches, libraries and edge cases in depth. Return options with trade-offs and a ranked recommendation.",
    { isolation: "shared" },
  ),
  reviewer(1, SONNET_HIGH, { isolation: "shared" }),
  reviewer(2, OPUS_HIGH, { isolation: "shared" }),
  reviewer(3, OPUS_HIGH, { isolation: "shared" }),
  preset(
    "review-t3-grok",
    "Reviewer (tier 3, Grok)",
    GROK_HIGH,
    "The second tier 3 reviewer, beside the Opus one: assume the code is wrong and try to break it. Never edit code. Reply once per round: each finding with file, line, severity and a concrete fix.",
    { isolation: "shared", runsIn: "host" },
  ),
  reviewer(4, OPUS_XHIGH, { isolation: "shared" }),
  reviewer(5, OPUS_XHIGH, { isolation: "shared" }),
  preset(
    "governor",
    "Governor",
    FABLE_HIGH,
    "Answer questions meant for the user during a merge-conflict resolution when the facts support a confident decision; otherwise return the options and a recommendation. Never edit code.",
  ),
  preset(
    "ticket",
    "Ticket agent",
    OPUS_HIGH,
    "File one Linear ticket per request. Search Linear for duplicates first, write in Aman's style, and reply with the ticket ids and URLs.",
    { skills: [SKILL, "aman-style"] },
  ),
  preset(
    "bugbot",
    "BugBot",
    OPUS_HIGH,
    "Answer one person's bug reports in chat: triage them, file the issues, and start an investigator per issue. Never touch production.",
    { allowedChildRoles: ["investigator", "ticket"] },
  ),
  preset(
    "investigator",
    "Investigator",
    OPUS_HIGH,
    "Investigate one reported issue. Production is read-only; file and link the bugfix ticket, and propose a one-off fix only through the approval flow.",
  ),
];
