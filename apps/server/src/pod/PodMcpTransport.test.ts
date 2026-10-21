import { describe, expect, it } from "@effect/vitest";

import { selectPodMcpTransport } from "./PodMcpTransport.ts";

describe("pod MCP transport", () => {
  it.each([
    { hostPlatform: "darwin", operatingSystem: "Docker Desktop", expected: "loopback" },
    { hostPlatform: "darwin", operatingSystem: "OrbStack", expected: "loopback" },
    { hostPlatform: "darwin", operatingSystem: "Ubuntu 24.04 LTS", expected: "loopback" },
    { hostPlatform: "darwin", operatingSystem: null, expected: "loopback" },
    { hostPlatform: "win32", operatingSystem: "Docker Desktop", expected: "loopback" },
    { hostPlatform: "linux", operatingSystem: "Docker Desktop", expected: "loopback" },
    { hostPlatform: "linux", operatingSystem: "Arch Linux", expected: "gateway" },
    {
      hostPlatform: "linux",
      operatingSystem: "Debian GNU/Linux 12 (bookworm)",
      expected: "gateway",
    },
    { hostPlatform: "linux", operatingSystem: null, expected: "gateway" },
  ] as const)(
    "$hostPlatform with $operatingSystem uses $expected",
    ({ hostPlatform, operatingSystem, expected }) => {
      expect(selectPodMcpTransport({ hostPlatform, operatingSystem })).toBe(expected);
    },
  );
});
