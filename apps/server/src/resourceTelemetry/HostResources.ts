import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat subtracts speculative pages from its printed "Pages free" count.
  // Adding them here counts each reclaimable page once; purgeable pages overlap.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

export function linuxSwap(
  meminfo: string,
): { readonly swapUsedBytes: number; readonly swapTotalBytes: number } | null {
  const total = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
  const free = /^SwapFree:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
  if (!total || !free) return null;
  const swapTotalBytes = Number(total) * 1024;
  return { swapTotalBytes, swapUsedBytes: Math.max(0, swapTotalBytes - Number(free) * 1024) };
}

const SWAP_UNIT_BYTES: Record<string, number> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** Parses `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1024.25M  free = …`. */
export function darwinSwap(
  output: string,
): { readonly swapUsedBytes: number; readonly swapTotalBytes: number } | null {
  const bytes = (match: RegExpExecArray | null) => {
    if (!match) return null;
    const value = Number(match[1]) * SWAP_UNIT_BYTES[match[2]!]!;
    return Number.isFinite(value) ? Math.round(value) : null;
  };
  const swapTotalBytes = bytes(/\btotal = ([\d.]+)([KMGT])\b/.exec(output));
  const swapUsedBytes = bytes(/\bused = ([\d.]+)([KMGT])\b/.exec(output));
  return swapTotalBytes === null || swapUsedBytes === null
    ? null
    : { swapTotalBytes, swapUsedBytes };
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    yield* Effect.sleep("200 millis");
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    let swap: ReturnType<typeof linuxSwap> = null;
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
      swap = linuxSwap(meminfo);
    } else if (platform === "darwin") {
      const run = (command: string, args: ReadonlyArray<string>) =>
        spawner
          .string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }))
          .pipe(
            Effect.timeout("1 second"),
            Effect.orElseSucceed(() => ""),
          );
      const output = yield* Effect.all(
        {
          vmStat: run("/usr/bin/vm_stat", []),
          swapusage: run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
        },
        { concurrency: 2 },
      );
      availableMemoryBytes = darwinAvailableMemory(output.vmStat) ?? availableMemoryBytes;
      swap = darwinSwap(output.swapusage);
    }
    // Windows reports [0, 0, 0]; that reads as no load, never as pressure.
    const loadAverage1m = NodeOS.loadavg()[0];
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      ...swap,
      ...(loadAverage1m === undefined || !Number.isFinite(loadAverage1m) ? {} : { loadAverage1m }),
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
