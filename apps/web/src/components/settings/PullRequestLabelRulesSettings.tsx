import { useRef } from "react";
import {
  DEFAULT_PULL_REQUEST_AGENT_LABELS,
  DEFAULT_PULL_REQUEST_LABEL_RULES,
  PULL_REQUEST_AGENT_STATES,
  pullRequestAgentLabelsProblem,
  READY_FOR_HUMAN_REVIEW_LABEL,
  type PullRequestAgentState,
} from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const STATE_LABELS = {
  investigating: "Investigating",
  building: "Building",
  reviewing: "Reviewing",
  done: "Done",
  revising: "Revising",
} satisfies Record<PullRequestAgentState, string>;

const STATE_DESCRIPTIONS = {
  investigating: "The pull request is linked and no work has started since.",
  building: "The thread or a thread it started is working.",
  reviewing: "A reviewer thread has started working, through the fixes between rounds.",
  done: "Every thread has gone quiet, including after a single turn that opened the pull request.",
  revising: "Work started after the first done. Review and done follow; building does not return.",
} satisfies Record<PullRequestAgentState, string>;

export function PullRequestLabelRulesSettings() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["pullRequestLabelRules"]);
  const edited = useRef(false);
  const rules = settings.pullRequestLabelRules;
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.pullRequestLabelRules === true,
    );
  if (!supported) return null;

  const saveLabel = (state: PullRequestAgentState, value: string) => {
    const labels = { ...rules.labels, [state]: value || DEFAULT_PULL_REQUEST_AGENT_LABELS[state] };
    const problem = pullRequestAgentLabelsProblem(labels);
    if (problem !== null) {
      toastManager.add({ type: "error", title: "Label not saved", description: problem });
      return false;
    }
    updateSettings({ pullRequestLabelRules: { ...rules, labels } });
    return true;
  };

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestLabelRules"]}
        mixed={mixed}
        {...searchableSetting("pull-request-label-rules")}
        description={`Keeps one label on each open pull request a thread links, from what the thread and the threads it started are doing. Only these five labels are added or removed; other labels, including ${READY_FOR_HUMAN_REVIEW_LABEL}, are left alone.`}
        resetAction={
          mixed ||
          rules.enabled !== DEFAULT_PULL_REQUEST_LABEL_RULES.enabled ||
          PULL_REQUEST_AGENT_STATES.some(
            (state) => rules.labels[state] !== DEFAULT_PULL_REQUEST_AGENT_LABELS[state],
          ) ? (
            <SettingResetButton
              label="agent labels"
              onClick={() =>
                updateSettings({ pullRequestLabelRules: DEFAULT_PULL_REQUEST_LABEL_RULES })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Agent labels on pull requests"
            mixed={mixed}
            checked={mixed ? false : rules.enabled}
            onCheckedChange={(enabled) =>
              updateSettings({ pullRequestLabelRules: { ...rules, enabled } })
            }
          />
        }
      />
      {!mixed && rules.enabled
        ? PULL_REQUEST_AGENT_STATES.map((state) => (
            <SettingsRow
              key={state}
              serverScoped
              settingKeys={["pullRequestLabelRules"]}
              title={STATE_LABELS[state]}
              description={STATE_DESCRIPTIONS[state]}
              control={
                <Input
                  key={`${scopeKey}:${rules.labels[state]}`}
                  aria-label={`${STATE_LABELS[state]} label`}
                  spellCheck={false}
                  maxLength={50}
                  placeholder={DEFAULT_PULL_REQUEST_AGENT_LABELS[state]}
                  defaultValue={rules.labels[state]}
                  onChange={() => {
                    edited.current = true;
                  }}
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (
                      edited.current &&
                      value !== rules.labels[state] &&
                      !saveLabel(state, value)
                    ) {
                      event.target.value = rules.labels[state];
                    }
                    edited.current = false;
                  }}
                />
              }
            />
          ))
        : null}
    </>
  );
}
