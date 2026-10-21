// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { PodRuntimeId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PodExecSpec } from "../../pod/ContainerDriver.ts";
import { ProviderPodProcess } from "../../provider/PodProviderSessions.ts";
import {
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The CLI stops the MCP servers it started, but not their children: a
  // plugin's `bun server.ts` outlives its `bun run` wrapper (#3089). The child
  // holds a FIFO open, so its death reads as end-of-file here, with no polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const session = yield* openFakeCli(cli);
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
    }).pipe(Effect.provide(realQueryRunner)),
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI in a pod", () => {
  it.effect("runs through the pod's launch with only the session's own environment", () =>
    Effect.gen(function* () {
      // Stands in for the docker CLI the launch names.
      const docker = fakeClaudeCli("cat > /dev/null");
      const worktree = NodePath.dirname(docker);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(worktree, { recursive: true, force: true })),
      );
      let launched: (spec: Omit<PodExecSpec, "user">) => void = () => {};
      const launch = new Promise<Omit<PodExecSpec, "user">>((resolve) => (launched = resolve));
      let stopped: () => void = () => {};
      const stop = new Promise<void>((resolve) => (stopped = resolve));
      const podProcess: typeof ProviderPodProcess.Service = {
        resolve: (cwd) =>
          Effect.succeed(
            cwd === worktree
              ? {
                  type: "pod",
                  podId: PodRuntimeId.make("pod-claude1"),
                  state: "running",
                  worktreePath: worktree,
                  dockerHost: "",
                }
              : undefined,
          ),
        command: (hostCommand) => Effect.succeed(`/opt/t3/provider-bin${hostCommand}`),
        launch: (_target, spec) => {
          launched(spec);
          return { command: docker, args: [], env: {}, stop: Effect.sync(() => stopped()) };
        },
      };
      const session = yield* Effect.gen(function* () {
        const runner = yield* ClaudeAgentSdkQueryRunner;
        return yield* runner.open({
          threadId: ThreadId.make("thread-pod-cli"),
          providerSessionId: ProviderSessionId.make("session-pod-cli"),
          options: {
            sessionId: "native-session-pod-cli",
            model: "claude-sonnet-4-6",
            tools: [],
            permissionMode: "default",
            cwd: worktree,
            pathToClaudeCodeExecutable: "/home/dev/.local/bin/claude",
            env: { ANTHROPIC_API_KEY: "sk-host", PATH: "/host/bin", HOST_ONLY: "1" },
          },
          podEnvironment: {
            CLAUDE_CONFIG_DIR: "/home/dev/.claude-work",
            CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
          },
        });
      }).pipe(
        Effect.provide(
          layerQueryRunner.pipe(
            Layer.provide(Layer.succeed(ProviderPodProcess, podProcess)),
            Layer.provide(
              Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const spec = yield* Effect.promise(() => launch);
      yield* session.close;
      // The CLI's exit stops what it left in the container.
      yield* Effect.promise(() => stop);

      expect(spec.command[0]).toBe("/opt/t3/provider-bin/home/dev/.local/bin/claude");
      expect(spec.cwd).toBe(worktree);
      expect(spec.env).toMatchObject({
        CLAUDE_CONFIG_DIR: "/home/dev/.claude-work",
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      });
      for (const name of ["ANTHROPIC_API_KEY", "PATH", "HOST_ONLY", "HOME"]) {
        expect(spec.env, name).not.toHaveProperty(name);
      }
    }),
  );
});
