import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PULL_REQUEST_LABEL_RULES,
  PullRequestLabelRules,
  READY_FOR_HUMAN_REVIEW_LABEL,
} from "./pullRequestLabelRules.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import { ThreadPullRequestLink } from "./threadPullRequest.ts";

const decodeRules = Schema.decodeUnknownSync(PullRequestLabelRules);

describe("PullRequestLabelRules", () => {
  it("is off with the Agent label names when settings never mention it", () => {
    expect(Schema.decodeUnknownSync(ServerSettings)({}).pullRequestLabelRules).toEqual(
      DEFAULT_PULL_REQUEST_LABEL_RULES,
    );
    expect(decodeRules({ enabled: true, labels: { done: "Shipped" } }).labels).toMatchObject({
      investigating: "Agent Investigating",
      done: "Shipped",
    });
  });

  it("refuses names it could not own alone", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(() => patch({ pullRequestLabelRules: { labels: { building: "agent done" } } })).toThrow(
      /own label name/,
    );
    expect(() =>
      patch({ pullRequestLabelRules: { labels: { reviewing: READY_FOR_HUMAN_REVIEW_LABEL } } }),
    ).toThrow(/set by people/);
  });
});

describe("ThreadPullRequestLink", () => {
  it("decodes links saved before the done fact", () => {
    const link = Schema.decodeUnknownSync(ThreadPullRequestLink)({
      host: "github.com",
      repository: "owner/repo",
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      source: "manual",
      linkedAt: "2026-10-01T00:00:00.000Z",
      snapshot: null,
      stack: null,
    });
    expect(link.agentDoneAt).toBeUndefined();
  });
});
