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
  // Used bytes over total, not `1 - available / total`, so a boundary like 85% compares exactly.
  const ram =
    sample.totalMemoryBytes > 0
      ? (sample.totalMemoryBytes - sample.availableMemoryBytes) / sample.totalMemoryBytes
      : null;
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

export interface HostResourceVerdicts {
  readonly cpu: HostHeadroom;
  readonly ram: HostHeadroom;
  readonly swap: HostHeadroom;
  readonly load: HostHeadroom;
}

const RANK: Record<HostHeadroom, number> = { unknown: -1, ok: 0, low: 1, exhausted: 2 };

const band = (value: number | null, low: number, exhausted: number): HostHeadroom =>
  value === null ? "unknown" : value > exhausted ? "exhausted" : value > low ? "low" : "ok";

/**
 * Fixed thresholds over used fractions: RAM used above 85% is low and above 95%
 * exhausted; swap used above 50% low and above 90% exhausted; 1-minute load per
 * CPU above 1.5 low and above 3 exhausted; CPU above 90% on this and the
 * previous sample low. A resource the host did not report is `unknown`.
 */
export function hostResourceVerdicts(
  pressure: HostPressure,
  previousCpu: number | null = null,
): HostResourceVerdicts {
  return {
    cpu:
      pressure.cpu === null
        ? "unknown"
        : pressure.cpu > 0.9 && previousCpu !== null && previousCpu > 0.9
          ? "low"
          : "ok",
    ram: band(pressure.ram, 0.85, 0.95),
    swap: band(pressure.swap, 0.5, 0.9),
    load: band(pressure.load, 1.5, 3),
  };
}

/**
 * The worst resource verdict. Unknown only when RAM is: a host without swap,
 * load or a CPU reading still has a verdict. The server runs on the host it
 * reports, so `os.*` readings are the host's.
 */
export function hostHeadroom(sample: HostSample, previous?: HostSample | null): HostHeadroom {
  const verdicts = hostResourceVerdicts(hostPressure(sample), previous?.cpuUtilization ?? null);
  if (verdicts.ram === "unknown") return "unknown";
  return [verdicts.cpu, verdicts.swap, verdicts.load].reduce<HostHeadroom>(
    (left, right) => (RANK[right] > RANK[left] ? right : left),
    verdicts.ram,
  );
}
