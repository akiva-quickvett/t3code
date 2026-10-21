import { describe, expect, it } from "@effect/vitest";
import { PodRuntimeId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as ContainerDriver from "./ContainerDriver.ts";
import { planPod } from "./PodContainerPlan.ts";

const HOST_DOCKER = "unix:///run/user/1000/docker.sock";

/** Records what the driver hands the docker CLI; nothing is run. */
const recordingDriver = () => {
  const runs: Array<ProcessRunner.ProcessRunInput> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        runs.push(input);
        return {
          stdout: "container-id\n",
          stderr: "",
          code: 0 as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const host = Effect.gen(function* () {
    const context = yield* Layer.build(
      ContainerDriver.layerDocker.pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      ),
    );
    return Context.get(context, ContainerDriver.ContainerDriver).forHost(HOST_DOCKER);
  });
  return { runs, host };
};

const plan = planPod({
  podId: PodRuntimeId.make("pod-abc123"),
  environmentId: "env-1",
  image: "agent-image",
  network: "t3-pods",
  worktreePath: "/home/dev/worktrees/feature",
  gitCommonDir: "/home/dev/repo/.git",
  homeDirectory: "/home/dev",
  user: { uid: 1000, gid: 1000 },
  providerMounts: { configDirs: ["/home/dev/.claude"], codexHomes: [], binDirs: [] },
  gitConfigPath: null,
  ghConfigDir: null,
  seeds: null,
  podEnv: { DATABASE_URL: "postgres://secret@db" },
  publish: [{ hostIp: "127.0.0.1", hostPort: 20000, containerPort: 3000 }],
});

describe("Docker container driver", () => {
  it.effect("creates both containers under an init with the planned mounts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runs, host } = recordingDriver();
        const docker = yield* host;
        yield* docker.createContainer(plan.dind);
        yield* docker.createContainer(plan.agent);
        const [dind, agent] = runs;
        expect(dind?.args).toEqual(expect.arrayContaining(["--init", "--privileged"]));
        expect(agent?.args).toContain("--init");
        expect(agent?.args).not.toContain("--privileged");
        // Only the daemon publishes, on the planned host address alone.
        expect(dind?.args).toEqual(
          expect.arrayContaining(["--publish", "127.0.0.1:20000:3000/tcp"]),
        );
        expect(agent?.args).not.toContain("--publish");
        const mounts = (args: ReadonlyArray<string>) =>
          args.flatMap((arg, index) => (args[index - 1] === "--mount" ? [arg] : []));
        expect(mounts(agent!.args)).toEqual([
          "type=tmpfs,tmpfs-mode=1777,dst=/home/dev",
          "type=bind,src=/home/dev/worktrees/feature,dst=/home/dev/worktrees/feature",
          "type=bind,src=/home/dev/repo/.git,dst=/home/dev/repo/.git",
          "type=bind,src=/home/dev/.claude,dst=/home/dev/.claude",
        ]);
      }),
    ),
  );

  it.effect(
    "keeps the CLI on the host's daemon and its PATH while the container gets its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { runs, host } = recordingDriver();
          const docker = yield* host;
          yield* docker.createContainer(plan.agent);
          yield* docker.exec("agent", {
            command: ["docker", "compose", "up", "-d"],
            env: { DOCKER_HOST: "tcp://127.0.0.1:2375", APP_TOKEN: "secret" },
            timeoutMs: 1_000,
          });
          const launch = docker.execLaunch("agent", {
            command: ["sh"],
            env: { PATH: "/opt/bin:/bin", TERM: "xterm" },
            tty: true,
          });
          const create = runs[0]!;
          const exec = runs[1]!;
          for (const env of [create.env, exec.env, launch.env]) {
            expect(env?.DOCKER_HOST).toBe(HOST_DOCKER);
            expect(env).not.toHaveProperty("PATH");
            expect(env).not.toHaveProperty("HOME");
          }
          // The container's own values for names the CLI reads travel inline.
          expect(create.args).toEqual(
            expect.arrayContaining(["-e", "DOCKER_HOST=tcp://127.0.0.1:2375"]),
          );
          expect(create.args.some((arg) => arg.startsWith("PATH="))).toBe(true);
          // Everything else goes by name, so secrets stay out of argv.
          expect(create.args).toEqual(expect.arrayContaining(["-e", "DATABASE_URL"]));
          expect(create.args.join(" ")).not.toContain("secret");
          expect(create.env?.DATABASE_URL).toBe("postgres://secret@db");
          expect(exec.args).toEqual(expect.arrayContaining(["-e", "APP_TOKEN"]));
          expect(exec.env?.APP_TOKEN).toBe("secret");
          expect(launch.args).toEqual(expect.arrayContaining(["-e", "PATH=/opt/bin:/bin", "-t"]));
        }),
      ),
  );
});
