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
const recordingDriver = (
  respond: (input: ProcessRunner.ProcessRunInput) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
  } = () => ({}),
) => {
  const runs: Array<ProcessRunner.ProcessRunInput> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        runs.push(input);
        const response = respond(input);
        return {
          // A pod network's inspect answers with its subnet and gateway.
          stdout:
            response.stdout ??
            (input.args[0] === "network"
              ? JSON.stringify([
                  { IPAM: { Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }] } },
                ])
              : "container-id\n"),
          stderr: response.stderr ?? "",
          code: (response.code ?? 0) as never,
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
  providerMounts: {
    configDirs: ["/home/dev/.claude"],
    homeSeeds: [],
    codexHomes: [],
    binDirs: [],
    toolDirs: [],
  },
  gitConfigPath: null,
  ghConfigDir: null,
  seeds: null,
  podEnv: { DATABASE_URL: "postgres://secret@db" },
  dns: [],
  proxyCaRoot: null,
  filesDir: null,
  mcpTransport: "gateway",
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
        const [, dind, agent] = runs;
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

  it.effect("maps the host alias to Docker's host-gateway without asking for the network", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runs, host } = recordingDriver();
        yield* (yield* host).createContainer({
          ...plan.dind,
          hostAlias: { name: "host.docker.internal", address: "host-gateway" },
        });
        expect(runs.map((run) => run.args[0])).toEqual(["create"]);
        expect(runs[0]?.args).toEqual(
          expect.arrayContaining(["--add-host", "host.docker.internal:host-gateway"]),
        );
      }),
    ),
  );

  it.effect("points the host alias at the pod network's gateway, shared by the agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runs, host } = recordingDriver();
        const docker = yield* host;
        yield* docker.createContainer(plan.dind);
        yield* docker.createContainer(plan.agent);
        const [inspect, dind, agent] = runs;
        expect(inspect?.args).toEqual(["network", "inspect", "t3-pods"]);
        expect(dind?.args).toEqual(
          expect.arrayContaining(["--add-host", "host.docker.internal:172.18.0.1"]),
        );
        // Docker refuses --add-host with a container network; the agent uses the daemon's hosts file.
        expect(agent?.args).not.toContain("--add-host");
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

  it.effect("reads another container's state, addresses and mounts, and null when it is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inspected = JSON.stringify([
          {
            State: { Status: "running" },
            NetworkSettings: { Networks: { pods: { IPAddress: "172.21.0.4" } } },
            Mounts: [{ Source: "/home/dev/routes", Destination: "/routes", RW: false }],
          },
        ]);
        const docker = yield* recordingDriver((input) =>
          input.args.at(-1) === "gone"
            ? { stdout: "[]", stderr: "Error: No such container: gone", code: 1 }
            : { stdout: inspected },
        ).host;
        expect(yield* docker.inspect("pods-proxy")).toEqual({
          status: "running",
          networks: { pods: "172.21.0.4" },
          mounts: [{ source: "/home/dev/routes", destination: "/routes" }],
        });
        expect(yield* docker.inspect("gone")).toBeNull();
      }),
    ),
  );

  it.effect("builds T3's image from its Dockerfile only when the host lacks it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let present = false;
        const { runs, host } = recordingDriver((input) =>
          input.args[0] === "image" && input.args[1] === "inspect" && !present
            ? { code: 1, stderr: "Error: No such image: t3.invalid/pod-agent:1" }
            : input.args[1] === "ls"
              ? { stdout: "t3.invalid/pod-agent:0\nt3.invalid/pod-agent:1\n" }
              : {},
        );
        const driver = yield* host;
        const image = { tag: "t3.invalid/pod-agent:1", dockerfile: "FROM scratch\n", labels: {} };
        expect(yield* driver.ensureImage(image)).toBe(true);
        const build = runs.find((run) => run.args[0] === "build");
        expect(build?.args).toEqual(["build", "--tag", "t3.invalid/pod-agent:1", "-"]);
        expect(build?.stdin).toBe("FROM scratch\n");
        // Then the earlier builds go; Docker keeps those a container still uses.
        expect(runs.filter((run) => run.args[1] === "rm").map((run) => run.args[2])).toEqual([
          "t3.invalid/pod-agent:0",
        ]);
        present = true;
        runs.length = 0;
        expect(yield* driver.ensureImage(image)).toBe(false);
        expect(runs.map((run) => run.args[0])).toEqual(["image"]);
      }),
    ),
  );

  it.effect("builds once for pods that start together, and names why a build failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let built = 0;
        const { host } = recordingDriver((input) => {
          if (input.args[0] === "image")
            return built > 0 ? {} : { code: 1, stderr: "Error: No such image" };
          built += 1;
          return {};
        });
        const driver = yield* host;
        const image = { tag: "t3.invalid/pod-agent:abc", dockerfile: "FROM scratch\n", labels: {} };
        const results = yield* Effect.all([driver.ensureImage(image), driver.ensureImage(image)], {
          concurrency: "unbounded",
        });
        expect(built).toBe(1);
        expect([...results].sort()).toEqual([false, true]);

        const offline = recordingDriver((input) =>
          input.args[0] === "build"
            ? {
                code: 1,
                stderr: [
                  '#0 building with "default" instance using docker driver',
                  "#3 [internal] load metadata for docker.io/library/node",
                  "#3 ERROR: dial tcp: lookup registry-1.docker.io: no such host",
                  "ERROR: failed to solve: node: failed to resolve source metadata",
                ].join("\n"),
              }
            : { code: 1, stderr: "Error: No such image" },
        );
        const failed = yield* (yield* offline.host).ensureImage(image).pipe(Effect.flip);
        expect(failed.daemonMessage).toBe(
          "ERROR: failed to solve: node: failed to resolve source metadata",
        );
      }),
    ),
  );

  it.effect("joins a network once, and reports what a failed command printed last", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runs, host } = recordingDriver((input) =>
          input.args[0] === "network" && input.args[1] === "connect"
            ? {
                stderr:
                  "Error response from daemon: endpoint with name t3-dind already exists in network pods",
                code: 1,
              }
            : input.args[0] === "exec"
              ? { stdout: "pulling\n", stderr: "\nError: pull access denied\n", code: 1 }
              : {},
        );
        const docker = yield* host;
        yield* docker.connectNetwork("pods", "t3-dind");
        expect(runs[0]?.args).toEqual(["network", "connect", "pods", "t3-dind"]);
        const result = yield* docker.exec("agent", {
          command: ["docker", "compose", "up"],
          timeoutMs: 1_000,
        });
        expect(result).toEqual({
          exitCode: 1,
          timedOut: false,
          outputTail: "pulling | Error: pull access denied",
        });
        yield* docker.createContainer({ ...plan.dind, dns: ["172.21.0.2"] });
        expect(runs.at(-1)?.args).toEqual(expect.arrayContaining(["--dns", "172.21.0.2"]));
      }),
    ),
  );
});
