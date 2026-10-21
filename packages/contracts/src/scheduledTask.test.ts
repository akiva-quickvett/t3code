import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
// The task as a client built before actions decodes it.
const { action: _action, ...stockTaskFields } = ScheduledTask.fields;
const decodeStockTask = Schema.decodeUnknownSync(Schema.Struct(stockTaskFields));

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

describe("ScheduledTask action", () => {
  const storedTask = {
    id: "scheduled-task:1",
    title: "Board sync",
    prompt: "Runs the project's board sync script.",
    enabled: true,
    schedule: { type: "interval", everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS },
    projectId: "project:1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };

  it("reads a task without an action as before, which means an agent turn", () => {
    const decoded = decodeTask(storedTask);
    expect(decoded.action).toBeUndefined();
    expect(decoded.prompt).toBe(storedTask.prompt);
  });

  it("reads a script action", () => {
    const decoded = decodeTask({
      ...storedTask,
      action: { type: "script", scriptId: "board-sync" },
    });
    expect(decoded.action).toEqual({ type: "script", scriptId: "board-sync" });
  });

  it("stays decodable for a stock client that has no action field", () => {
    const decoded = decodeStockTask({
      ...storedTask,
      action: { type: "script", scriptId: "board-sync" },
    });
    expect(decoded.title).toBe("Board sync");
    expect("action" in decoded).toBe(false);
  });
});
