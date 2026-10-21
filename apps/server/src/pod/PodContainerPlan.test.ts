import { describe, expect, it } from "@effect/vitest";
import { PodRuntimeId } from "@t3tools/contracts";

import { planPod, type PodPlanInput } from "./PodContainerPlan.ts";

const input: PodPlanInput = {
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
    codexHomes: ["/home/dev/.codex", "/home/dev/.codex-work"],
    binDirs: ["/home/dev/.local/bin"],
  },
  gitConfigPath: "/home/dev/.gitconfig",
  ghConfigDir: "/home/dev/.config/gh",
  seeds: { dir: "/home/dev/pods/seeds/repo", name: "repo" },
  podEnv: {
    DATABASE_URL: "postgres://db",
    ANTHROPIC_API_KEY: "sk-ant",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  },
  publish: [],
};

const mountList = (
  mounts: ReadonlyArray<{ type: string; source: string; target: string; readOnly: boolean }>,
) =>
  mounts.map((mount) =>
    `${mount.type} ${mount.type === "tmpfs" ? "" : mount.source}:${mount.target}${mount.readOnly ? " ro" : ""}`.trim(),
  );

describe("pod container plan", () => {
  it("runs both containers under an init", () => {
    const plan = planPod(input);
    expect(plan.dind.init).toBe(true);
    expect(plan.agent.init).toBe(true);
  });

  it("mounts exactly the agent's working set, at the host's own paths", () => {
    expect(mountList(planPod(input).agent.mounts)).toEqual([
      "tmpfs :/home/dev",
      "bind /home/dev/worktrees/feature:/home/dev/worktrees/feature",
      "bind /home/dev/repo/.git:/home/dev/repo/.git",
      "bind /home/dev/.claude:/home/dev/.claude",
      "bind /home/dev/.codex:/home/dev/.codex",
      "bind /home/dev/.codex-work:/home/dev/.codex-work",
      "bind /home/dev/.local/bin:/opt/t3/provider-bin/0 ro",
      "bind /home/dev/.gitconfig:/home/dev/.gitconfig ro",
      "bind /home/dev/.config/gh:/home/dev/.config/gh ro",
      "bind /home/dev/pods/seeds/repo:/seeds/repo ro",
    ]);
  });

  it("runs dockerd itself, so the image adds no listener open to the pods network", () => {
    // A first argument that is a flag makes docker:dind's entrypoint add
    // --host=tcp://0.0.0.0:2375, which clashes with the loopback listener.
    expect(planPod(input).dind.command).toEqual([
      "dockerd",
      "--host=unix:///var/run/docker.sock",
      "--host=tcp://127.0.0.1:2375",
    ]);
  });

  it("gives the daemon only its volume, the worktree and seeds", () => {
    expect(mountList(planPod(input).dind.mounts)).toEqual([
      "volume t3-env1-pod-abc123-dockerlib:/var/lib/docker",
      "bind /home/dev/worktrees/feature:/home/dev/worktrees/feature",
      "bind /home/dev/pods/seeds/repo:/seeds/repo ro",
    ]);
  });

  it("never mounts the T3 home, /tmp or a multiplexer socket", () => {
    const plan = planPod(input);
    for (const mount of [...plan.agent.mounts, ...plan.dind.mounts]) {
      expect(mount.source).not.toMatch(/\.t3|^\/tmp|herdr|tmux|\.sock$/);
    }
  });

  it("sets an explicit environment without host credentials", () => {
    const { env, user, workdir, network } = planPod(input).agent;
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).toMatchObject({
      DATABASE_URL: "postgres://db",
      HOME: "/home/dev",
      DOCKER_HOST: "tcp://127.0.0.1:2375",
    });
    // Host binaries come after the image's own, so they never shadow them.
    expect(env.PATH?.endsWith(":/bin:/opt/t3/provider-bin/0")).toBe(true);
    expect(user).toBe("1000:1000");
    expect(workdir).toBe("/home/dev/worktrees/feature");
    expect(network).toEqual({ mode: "container", container: "t3-env1-pod-abc123-dind" });
  });

  it("labels everything with the pod and the environment that owns it", () => {
    const plan = planPod(input);
    for (const labels of [plan.dind.labels, plan.agent.labels, plan.volume.labels]) {
      expect(labels).toMatchObject({ "t3.pod": "pod-abc123", "t3.environment": "env-1" });
    }
  });
});
