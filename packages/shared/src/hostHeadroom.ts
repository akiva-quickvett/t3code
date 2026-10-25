import type { HostHeadroom, HostResourcesSnapshot } from "@t3tools/contracts";

/** Used fractions (0..1) and load per CPU; null where the host reported nothing usable. */
export interface HostPressure {
  readonly cpu: number | null;
  readonly ram: number | null;
  readonly swap: number | null;
  readonly load: number | null;
}

type HostSample = Pick<
  HostResourcesSnapshot,
  | "cpuUtilization"
  | "cpuCount"
  | "availableMemoryBytes"
  | "totalMemoryBytes"
  | "swapUsedBytes"
  | "swapTotalBytes"
  | "loadAverage1m"
>;

export function hostPressure(sample: HostSample): HostPressure {
  const ram =
    sample.totalMemoryBytes > 0 ? 1 - sample.availableMemoryBytes / sample.totalMemoryBytes : null;
  const swap =
    sample.swapUsedBytes !== undefined &&
    sample.swapTotalBytes !== undefined &&
    sample.swapTotalBytes > 0
      ? sample.swapUsedBytes / sample.swapTotalBytes
      : null;
  const load =
    sample.loadAverage1m !== undefined && sample.cpuCount > 0
      ? sample.loadAverage1m / sample.cpuCount
      : null;
  return { cpu: sample.cpuUtilization, ram, swap, load };
}

const RANK: Record<"ok" | "low" | "exhausted", number> = { ok: 0, low: 1, exhausted: 2 };

const worst = (verdicts: ReadonlyArray<"ok" | "low" | "exhausted">) =>
  verdicts.reduce((left, right) => (RANK[right] > RANK[left] ? right : left), "ok");

/**
 * Fixed thresholds: RAM available below 15% is low and below 5% exhausted; swap
 * used above 50% low and above 90% exhausted; 1-minute load per CPU above 1.5
 * low and above 3 exhausted; CPU above 90% on this and the previous sample low.
 * The server runs on the host it reports, so `os.*` readings are the host's.
 */
export function hostHeadroom(sample: HostSample, previous?: HostSample | null): HostHeadroom {
  if (sample.totalMemoryBytes <= 0) return "unknown";
  // From the raw bytes, not `1 - ram`, so a boundary like 15% compares exactly.
  const ramAvailable = sample.availableMemoryBytes / sample.totalMemoryBytes;
  const pressure = hostPressure(sample);
  const previousCpu = previous?.cpuUtilization ?? null;
  return worst([
    ramAvailable < 0.05 ? "exhausted" : ramAvailable < 0.15 ? "low" : "ok",
    pressure.swap === null
      ? "ok"
      : pressure.swap > 0.9
        ? "exhausted"
        : pressure.swap > 0.5
          ? "low"
          : "ok",
    pressure.load === null
      ? "ok"
      : pressure.load > 3
        ? "exhausted"
        : pressure.load > 1.5
          ? "low"
          : "ok",
    pressure.cpu !== null && pressure.cpu > 0.9 && previousCpu !== null && previousCpu > 0.9
      ? "low"
      : "ok",
  ]);
}
