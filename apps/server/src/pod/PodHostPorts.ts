import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Pod services are published from here. Below Linux's ephemeral range, which
 * outgoing connections take ports from, and above T3's own dev ports. Nothing
 * else on the host serves from it by convention: not 80/443 (orch's pods proxy),
 * not 8443 (T3's tailscale serve).
 */
export const POD_HOST_PORT_RANGE = { first: 20_000, last: 29_999 } as const;

/** `no-address` when the address is not this host's, as a tailnet address once Tailscale is down. */
export type PortProbe = "free" | "in-use" | "no-address";

/** The host's view of its own ports and addresses; tests swap in a fake. */
export class PodHostNetwork extends Context.Service<
  PodHostNetwork,
  {
    /** Whether a listener could bind `address:port` right now. */
    readonly probePort: (address: string, port: number) => Effect.Effect<PortProbe>;
    /** This host's tailnet IPv4 address, if Tailscale is up. */
    readonly tailnetAddress: Effect.Effect<string | null>;
    /** The resolvers this host asks, as `resolv.conf` text; empty when none can be read. */
    readonly resolvConf: Effect.Effect<string>;
  }
>()("t3/pod/PodHostPorts/PodHostNetwork") {}

/** systemd-resolved's list of its real upstreams first: the system one names only its stub. */
const RESOLV_CONF_PATHS = ["/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"] as const;

const readResolvConf = (fileSystem: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    for (const file of RESOLV_CONF_PATHS) {
      const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
      if (Option.isSome(text)) return text.value;
    }
    return "";
  });

const UPSTREAM_NAMESERVERS_MAX = 3;
/** Tailscale's MagicDNS answers only on the host's own tailnet interface. */
const TAILSCALE_RESOLVER = "100.100.100.100";

/**
 * The host's real upstream resolvers, for a pod's daemon whose network
 * Docker's own DNS fails on. Only IPv4: the pods network has no IPv6. A
 * loopback stub, Tailscale's resolver and link-local addresses cannot be
 * reached from a container, so they are skipped.
 */
export const upstreamNameservers = (resolvConf: string): ReadonlyArray<string> =>
  resolvConf
    .split(/\r?\n/)
    .flatMap((line) => {
      const [keyword, address, ...rest] = line.trim().split(/\s+/);
      return keyword === "nameserver" && address !== undefined && rest.length === 0
        ? [address]
        : [];
    })
    .filter(
      (address) =>
        NodeNet.isIPv4(address) &&
        !address.startsWith("127.") &&
        !address.startsWith("169.254.") &&
        address !== TAILSCALE_RESOLVER,
    )
    .slice(0, UPSTREAM_NAMESERVERS_MAX);

const bindProbe = (address: string, port: number) =>
  Effect.callback<PortProbe>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resume(Effect.succeed(error.code === "EADDRNOTAVAIL" ? "no-address" : "in-use")),
    );
    server.listen({ host: address, port, exclusive: true }, () =>
      server.close(() => resume(Effect.succeed("free"))),
    );
    return Effect.sync(() => server.close());
  });

const findTailnetAddress = () => {
  for (const [name, entries = []] of Object.entries(NodeOS.networkInterfaces())) {
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (/^tailscale/i.test(name) || isTailscaleIpv4Address(entry.address)) return entry.address;
    }
  }
  return null;
};

export const layer = Layer.effect(
  PodHostNetwork,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return PodHostNetwork.of({
      probePort: bindProbe,
      tailnetAddress: Effect.sync(findTailnetAddress),
      resolvConf: readResolvConf(fileSystem),
    });
  }),
);

export interface PodServicePorts {
  readonly name: string;
  /** Inside the pod. */
  readonly port: number;
  readonly hostPort: number;
}

const missingAddress = (address: string) =>
  `${address} is not an address of this host (is Tailscale up?); turn it on, or Recreate the pod to publish on loopback only`;

export class PodHostAddressError extends Schema.TaggedError<PodHostAddressError>()(
  "PodHostAddressError",
  { address: Schema.String },
) {
  override get message(): string {
    return `${missingAddress(this.address)}.`;
  }
}

export class PodHostPortsExhaustedError extends Schema.TaggedError<PodHostPortsExhaustedError>()(
  "PodHostPortsExhaustedError",
  { serviceName: Schema.String },
) {
  override get message(): string {
    return `No free host port for service ${this.serviceName} in ${POD_HOST_PORT_RANGE.first}-${POD_HOST_PORT_RANGE.last}.`;
  }
}

/**
 * Host ports for a pod's services. A service keeps the port it had, so links
 * and rendered `.env` values survive stop, start and recreate; a new service
 * gets the lowest port no pod holds and nothing on the host listens on.
 */
export const allocatePodHostPorts = (input: {
  readonly services: Readonly<Record<string, number>>;
  readonly previous: Readonly<Record<string, number>>;
  /** Every port other pods hold, running or not. */
  readonly taken: ReadonlySet<number>;
  readonly addresses: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const network = yield* PodHostNetwork;
    const held = new Set(input.taken);
    const allocated: Array<PodServicePorts> = [];
    const pending: Array<[string, number]> = [];
    for (const [name, port] of Object.entries(input.services)) {
      const previous = input.previous[name];
      if (previous !== undefined && !held.has(previous)) {
        held.add(previous);
        allocated.push({ name, port, hostPort: previous });
      } else pending.push([name, port]);
    }
    let candidate = POD_HOST_PORT_RANGE.first;
    for (const [name, port] of pending) {
      let hostPort: number | null = null;
      for (; candidate <= POD_HOST_PORT_RANGE.last && hostPort === null; candidate++) {
        if (held.has(candidate)) continue;
        if (yield* isFreeOnAll(network, input.addresses, candidate)) hostPort = candidate;
      }
      if (hostPort === null) return yield* new PodHostPortsExhaustedError({ serviceName: name });
      held.add(hostPort);
      allocated.push({ name, port, hostPort });
    }
    return allocated;
  });

/** An address that is not the host's fails at once, rather than making every port look taken. */
const isFreeOnAll = (
  network: PodHostNetwork["Service"],
  addresses: ReadonlyArray<string>,
  port: number,
) =>
  Effect.gen(function* () {
    for (const address of addresses) {
      const probe = yield* network.probePort(address, port);
      if (probe === "no-address") return yield* new PodHostAddressError({ address });
      if (probe === "in-use") return false;
    }
    return true;
  });

/** Why the pod cannot publish its ports now, as a sentence naming the port or address; null if it can. */
export const findPodPortClash = (
  services: ReadonlyArray<PodServicePorts>,
  addresses: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const network = yield* PodHostNetwork;
    for (const service of services)
      for (const address of addresses) {
        const probe = yield* network.probePort(address, service.hostPort);
        if (probe === "no-address") return missingAddress(address);
        if (probe === "in-use")
          return `port ${service.hostPort} for service ${service.name} is already in use on ${address}; stop what holds it, then retry`;
      }
    return null;
  });
