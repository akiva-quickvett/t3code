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
    configDirs: ["/home/dev/.claude", "/home/dev/.pi/agent"],
    homeSeeds: ["/home/dev/.claude.json"],
    codexHomes: ["/home/dev/.codex", "/home/dev/.codex-work"],
    binDirs: ["/home/dev/.local/bin"],
    toolDirs: ["/home/dev/.t3/tools/devin"],
  },
  gitConfigPath: "/home/dev/.gitconfig",
  ghConfigDir: "/home/dev/.config/gh",
  seeds: { dir: "/home/dev/pods/seeds/repo", name: "repo" },
  podEnv: {
    DATABASE_URL: "postgres://db",
    ANTHROPIC_API_KEY: "sk-ant",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  },
  dns: [],
  proxyCaRoot: null,
  filesDir: "/home/dev/.t3/caches/pods/pod-abc123",
  mcpTransport: "gateway",
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
      "bind /home/dev/.pi/agent:/home/dev/.pi/agent",
      "bind /home/dev/.codex:/home/dev/.codex",
      "bind /home/dev/.codex-work:/home/dev/.codex-work",
      "bind /home/dev/.local/bin:/opt/t3/provider-bin/home/dev/.local/bin ro",
      "bind /home/dev/.t3/tools/devin:/home/dev/.t3/tools/devin ro",
      "bind /home/dev/.t3/caches/pods/pod-abc123:/home/dev/.t3/caches/pods/pod-abc123 ro",
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

  it("copies .claude.json into the agent's home through the pod's files dir instead of binding it", () => {
    const plan = planPod(input);
    expect(plan.agent.mounts.some((mount) => mount.source.endsWith(".claude.json"))).toBe(false);
    expect(plan.homeSeeds).toEqual([
      {
        host: "/home/dev/.claude.json",
        snapshot: "/home/dev/.t3/caches/pods/pod-abc123/home/.claude.json",
        target: "/home/dev/.claude.json",
      },
    ]);
    expect(planPod({ ...input, filesDir: null }).homeSeeds).toEqual([]);
  });

  it("never mounts the T3 home, /tmp or a multiplexer socket", () => {
    const plan = planPod(input);
    for (const mount of [...plan.agent.mounts, ...plan.dind.mounts]) {
      expect(mount.source).not.toMatch(/^\/tmp|herdr|tmux|\.sock$/);
      // Of the T3 home, only a registry agent's install and the pod's own files, read-only.
      if (/\.t3/.test(mount.source)) {
        expect(mount.source).toMatch(/\/\.t3\/(tools\/[^/]+|caches\/pods\/pod-abc123)$/);
        expect(mount.readOnly).toBe(true);
      }
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
    expect(env.PATH?.endsWith(":/bin:/opt/t3/provider-bin/home/dev/.local/bin")).toBe(true);
    expect(user).toBe("1000:1000");
    expect(workdir).toBe("/home/dev/worktrees/feature");
    expect(network).toEqual({ mode: "container", container: "t3-env1-pod-abc123-dind" });
  });

  it("records on the daemon the network the pod was made on", () => {
    const { dind } = planPod(input);
    expect(dind.labels).toMatchObject({ "t3.network": "t3-pods" });
    // Beside the daemon's own command, which keeps dockerd first.
    expect(dind.command[0]).toBe("dockerd");
    expect(dind.hostAlias).toEqual({ name: "host.docker.internal", address: "gateway" });
    // An engine in a VM maps the alias to this machine itself; the gateway is not it.
    expect(planPod({ ...input, mcpTransport: "loopback" }).dind).not.toHaveProperty("hostAlias");
    // Unless resolvers of its own replace the engine's, which answers the name.
    expect(
      planPod({ ...input, mcpTransport: "loopback", dns: ["10.0.0.53"] }).dind.hostAlias,
    ).toEqual({ name: "host.docker.internal", address: "host-gateway" });
  });

  it("labels everything with the pod and the environment that owns it", () => {
    const plan = planPod(input);
    for (const labels of [plan.dind.labels, plan.agent.labels, plan.volume.labels]) {
      expect(labels).toMatchObject({ "t3.pod": "pod-abc123", "t3.environment": "env-1" });
    }
  });

  it("resolves through the given servers and trusts the proxy CA only when given one", () => {
    expect(planPod(input).dind).not.toHaveProperty("dns");
    expect(planPod(input).agent.env).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    const plan = planPod({
      ...input,
      dns: ["172.21.0.2", "192.168.1.1"],
      proxyCaRoot: "/home/dev/.local/state/herdr-orch/caddy/root.crt",
    });
    expect(plan.dind.dns).toEqual(["172.21.0.2", "192.168.1.1"]);
    // The daemon passes them on to the stack's containers.
    expect(plan.dind.command.slice(3)).toEqual(["--dns", "172.21.0.2", "--dns", "192.168.1.1"]);
    expect(mountList(plan.agent.mounts)).toContain(
      "bind /home/dev/.local/state/herdr-orch/caddy/root.crt:/usr/local/share/ca-certificates/t3-pods-proxy.crt ro",
    );
    expect(plan.agent.env.NODE_EXTRA_CA_CERTS).toBe(
      "/usr/local/share/ca-certificates/t3-pods-proxy.crt",
    );
  });
});
