import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PodHostPorts from "./PodHostPorts.ts";

/** `busy` holds `address:port` pairs something else listens on. */
const fakeNetwork = (busy: ReadonlySet<string> = new Set()) =>
  Layer.succeed(PodHostPorts.PodHostNetwork, {
    probePort: (address, port) =>
      Effect.succeed(
        address === "100.64.0.99"
          ? "no-address"
          : busy.has(`${address}:${port}`)
            ? "in-use"
            : "free",
      ),
    tailnetAddress: Effect.succeed(null),
    resolvConf: Effect.succeed(""),
  });

const loopback = ["127.0.0.1"];

describe("pod host port allocation", () => {
  it("draws from a range clear of the pods proxy, tailscale serve and ephemeral ports", () => {
    const { first, last } = PodHostPorts.POD_HOST_PORT_RANGE;
    for (const reserved of [80, 443, 8443]) expect(reserved < first || reserved > last).toBe(true);
    expect(last).toBeLessThan(32_768);
  });

  it.effect("keeps each service's port and skips ports other pods hold or the host uses", () =>
    PodHostPorts.allocatePodHostPorts({
      services: { web: 3000, api: 8000, docs: 4000 },
      previous: { web: 20_005 },
      taken: new Set([20_000]),
      addresses: loopback,
    }).pipe(
      Effect.map((allocated) =>
        expect(allocated).toEqual([
          { name: "web", port: 3000, hostPort: 20_005 },
          { name: "api", port: 8000, hostPort: 20_002 },
          { name: "docs", port: 4000, hostPort: 20_003 },
        ]),
      ),
      Effect.provide(fakeNetwork(new Set(["127.0.0.1:20001"]))),
    ),
  );

  it.effect("moves a service whose old port another pod now holds", () =>
    PodHostPorts.allocatePodHostPorts({
      services: { web: 3000 },
      previous: { web: 20_000 },
      taken: new Set([20_000]),
      addresses: loopback,
    }).pipe(
      Effect.map((allocated) => expect(allocated[0]?.hostPort).toBe(20_001)),
      Effect.provide(fakeNetwork()),
    ),
  );

  it.effect("needs a port free on every address it publishes on", () =>
    PodHostPorts.allocatePodHostPorts({
      services: { web: 3000 },
      previous: {},
      taken: new Set(),
      addresses: ["127.0.0.1", "100.64.0.9"],
    }).pipe(
      Effect.map((allocated) => expect(allocated[0]?.hostPort).toBe(20_001)),
      Effect.provide(fakeNetwork(new Set(["100.64.0.9:20000"]))),
    ),
  );

  it.effect("names a publish address the host no longer has, instead of a taken port", () =>
    Effect.gen(function* () {
      const allocating = yield* PodHostPorts.allocatePodHostPorts({
        services: { web: 3000 },
        previous: {},
        taken: new Set(),
        addresses: ["127.0.0.1", "100.64.0.99"],
      }).pipe(Effect.flip);
      expect(allocating.message).toBe(
        "100.64.0.99 is not an address of this host (is Tailscale up?); turn it on, or Recreate the pod to publish on loopback only.",
      );
      expect(
        yield* PodHostPorts.findPodPortClash(
          [{ name: "web", port: 3000, hostPort: 20_000 }],
          ["127.0.0.1", "100.64.0.99"],
        ),
      ).toContain("100.64.0.99 is not an address of this host");
    }).pipe(Effect.provide(fakeNetwork())),
  );

  it.effect("says which service found no port when the range is full", () => {
    const { first, last } = PodHostPorts.POD_HOST_PORT_RANGE;
    const taken = new Set(Array.from({ length: last - first + 1 }, (_, index) => first + index));
    return PodHostPorts.allocatePodHostPorts({
      services: { web: 3000 },
      previous: {},
      taken,
      addresses: loopback,
    }).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(error.message).toBe("No free host port for service web in 20000-29999."),
      ),
      Effect.provide(fakeNetwork()),
    );
  });
});

describe("host network probe", () => {
  it.effect("sees a port a listener holds as taken, and free once it closes", () =>
    Effect.gen(function* () {
      const network = yield* PodHostPorts.PodHostNetwork;
      const server = NodeNet.createServer();
      const port = yield* Effect.callback<number>((resume) => {
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
          const address = server.address();
          resume(
            Effect.succeed(typeof address === "object" && address !== null ? address.port : 0),
          );
        });
      });
      expect(yield* network.probePort("127.0.0.1", port)).toBe("in-use");
      yield* Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      });
      expect(yield* network.probePort("127.0.0.1", port)).toBe("free");
      // TEST-NET-1 is never this host's address.
      expect(yield* network.probePort("192.0.2.1", port)).toBe("no-address");
    }).pipe(Effect.provide(PodHostPorts.layer.pipe(Layer.provide(NodeServices.layer)))),
  );
});

describe("host upstream resolvers", () => {
  it("keeps the IPv4 upstreams a container can reach, at most three", () => {
    const resolvConf = [
      "# This is /run/systemd/resolve/resolv.conf managed by man:systemd-resolved(8).",
      "nameserver 127.0.0.53",
      "nameserver 127.0.0.1",
      "nameserver 100.100.100.100",
      "nameserver 169.254.169.254",
      "nameserver 192.168.1.1",
      "nameserver 2600:4040:ac1c:5400::1",
      "nameserver fd7a:115c:a1e0::53",
      "nameserver ::1",
      "nameserver dns.example.com",
      "nameserver 10.0.0.1 # trailing words make it no plain address",
      "search tail43a582.ts.net",
      "nameserver 1.1.1.1",
      "nameserver 8.8.8.8",
      "nameserver 9.9.9.9",
    ].join("\n");
    expect(PodHostPorts.upstreamNameservers(resolvConf)).toEqual([
      "192.168.1.1",
      "1.1.1.1",
      "8.8.8.8",
    ]);
    expect(PodHostPorts.upstreamNameservers("nameserver 127.0.0.53\n")).toEqual([]);
    expect(PodHostPorts.upstreamNameservers("")).toEqual([]);
  });
});
