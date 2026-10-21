import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import type { ContainerHost } from "./ContainerDriver.ts";

/**
 * How agents in a pod reach T3's pod-facing MCP listener; their URL is
 * `http://host.docker.internal:<port>/mcp` either way.
 *
 * - `gateway`: a native Linux engine. The pod network's gateway is an address
 *   of this machine, so the listener binds it, admits that network's subnet,
 *   and the daemon container maps the alias to it.
 * - `loopback`: an engine in a VM (Docker Desktop on any OS, every macOS
 *   engine). The gateway lives inside the VM, out of the host's reach, but the
 *   engine's own `host.docker.internal` is dialed from the host itself, so the
 *   listener binds 127.0.0.1. Peers are then always loopback, so the subnet
 *   check cannot tell pods apart and the bearer token is the boundary; the
 *   alias is the engine's, so the daemon container must not override it.
 */
export type PodMcpTransport = "gateway" | "loopback";

export interface PodEngine {
  readonly hostPlatform: NodeJS.Platform;
  /** `docker info`'s OperatingSystem; null when it could not be read. */
  readonly operatingSystem: string | null;
}

/**
 * Keyed on topology, not vendor: any engine off Linux runs in a VM, and
 * Docker Desktop runs one on Linux too. Unknown engines follow the host.
 */
export const selectPodMcpTransport = (engine: PodEngine): PodMcpTransport =>
  engine.hostPlatform !== "linux" || /docker desktop/i.test(engine.operatingSystem ?? "")
    ? "loopback"
    : "gateway";

export const POD_MCP_LOOPBACK_ADDRESS = "127.0.0.1";

/** The transport for pods on this Docker host, guessing from the host while the engine cannot say. */
export const podMcpTransportFor = (host: ContainerHost) =>
  Effect.gen(function* () {
    return selectPodMcpTransport({
      hostPlatform: yield* HostProcess.Platform,
      operatingSystem: yield* host.engineOperatingSystem,
    });
  });

/**
 * The same for containers about to be made, which keep it until a recreate:
 * on Linux only the engine can tell Docker Desktop's VM apart, so it must answer.
 */
export const requirePodMcpTransport = (host: ContainerHost) =>
  Effect.gen(function* () {
    const hostPlatform = yield* HostProcess.Platform;
    if (hostPlatform !== "linux")
      return selectPodMcpTransport({ hostPlatform, operatingSystem: null });
    return selectPodMcpTransport({
      hostPlatform,
      operatingSystem: yield* host.requireEngineOperatingSystem,
    });
  });
