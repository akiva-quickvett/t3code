import * as Effect from "effect/Effect";

import {
  ContainerDriver,
  ContainerDriverError,
  type ContainerDriverOperation,
  type ContainerHost,
  type PodContainerInfo,
  type PodContainerSpec,
  type PodContainerStatus,
} from "../ContainerDriver.ts";

export interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  status: PodContainerStatus;
  readonly spec: PodContainerSpec | null;
}

export interface FakeCall {
  readonly host: string;
  readonly operation: ContainerDriverOperation;
  /** Container name (when it exists), volume or network name. */
  readonly target: string | null;
  readonly command?: ReadonlyArray<string>;
}

/** An in-memory Docker: tests never start a real container. */
export const makeFakeContainerDriver = () => {
  const hosts = new Map<
    string,
    { containers: Map<string, FakeContainer>; volumes: Map<string, Record<string, string>> }
  >();
  const calls: Array<FakeCall> = [];
  let nextId = 1;
  let failWhen: (call: FakeCall) => boolean = () => false;
  let dieWhen: (call: FakeCall) => boolean = () => false;
  let execExitCode: (call: FakeCall) => number | null = () => 0;

  const hostState = (host: string) => {
    const existing = hosts.get(host);
    if (existing !== undefined) return existing;
    const created = { containers: new Map<string, FakeContainer>(), volumes: new Map() };
    hosts.set(host, created);
    return created;
  };

  const forHost = (host: string): ContainerHost => {
    const state = hostState(host);
    const find = (ref: string) =>
      state.containers.get(ref) ??
      [...state.containers.values()].find((container) => container.name === ref);
    const record = (
      operation: ContainerDriverOperation,
      target: string | null,
      command?: ReadonlyArray<string>,
    ) =>
      Effect.suspend(() => {
        // Containers are named in calls, so assertions read like the pod's plan.
        const named = target === null ? null : (find(target)?.name ?? target);
        const call: FakeCall = { host, operation, target: named, ...(command ? { command } : {}) };
        calls.push(call);
        if (dieWhen(call)) return Effect.die(new Error(`fake ${operation} crashed`));
        return failWhen(call)
          ? Effect.fail(
              new ContainerDriverError({
                operation,
                exitCode: 1,
                daemonMessage: `fake ${operation} refused`,
              }),
            )
          : Effect.succeed(call);
      });
    const setStatus = (
      operation: ContainerDriverOperation,
      ref: string,
      status: PodContainerStatus,
    ) =>
      record(operation, ref).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const container = find(ref);
            if (container !== undefined) container.status = status;
          }),
        ),
        Effect.asVoid,
      );
    return {
      list: (labelKey) =>
        record("list", labelKey).pipe(
          Effect.map(() => ({
            containers: [...state.containers.values()]
              .filter((container) => labelKey in container.labels)
              .map((container): PodContainerInfo => ({
                id: container.id,
                name: container.name,
                labels: container.labels,
                status: container.status,
              })),
            volumes: [...state.volumes.entries()]
              .filter(([, labels]) => labelKey in labels)
              .map(([name, labels]) => ({ name, labels })),
          })),
        ),
      ensureNetwork: (name) => record("network", name).pipe(Effect.asVoid),
      createVolume: ({ name, labels }) =>
        record("createVolume", name).pipe(
          Effect.tap(() => Effect.sync(() => state.volumes.set(name, { ...labels }))),
          Effect.asVoid,
        ),
      removeVolume: (name) =>
        record("removeVolume", name).pipe(
          Effect.tap(() => Effect.sync(() => state.volumes.delete(name))),
          Effect.asVoid,
        ),
      createContainer: (spec) =>
        record("createContainer", spec.name).pipe(
          Effect.map(() => {
            const id = `container-${nextId++}`;
            state.containers.set(id, {
              id,
              name: spec.name,
              labels: spec.labels,
              status: "created",
              spec,
            });
            return id;
          }),
        ),
      start: (id) => setStatus("start", id, "running"),
      stop: (id) => setStatus("stop", id, "exited"),
      pause: (id) => setStatus("pause", id, "paused"),
      unpause: (id) => setStatus("unpause", id, "running"),
      removeContainer: (id) =>
        record("removeContainer", id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const container = find(id);
              if (container !== undefined) state.containers.delete(container.id);
            }),
          ),
          Effect.asVoid,
        ),
      exec: (id, spec) =>
        record("exec", id, spec.command).pipe(
          Effect.map((call) => {
            const exitCode = execExitCode(call);
            return { exitCode, timedOut: exitCode === null };
          }),
        ),
      execLaunch: (id, spec) => ({
        command: "docker",
        args: ["exec", id, ...spec.command],
        env: { ...spec.env },
      }),
      memoryUsage: (ids) =>
        record("stats", null).pipe(
          Effect.map(
            () => new Map(ids.filter((id) => find(id) !== undefined).map((id) => [id, 1024])),
          ),
        ),
    };
  };

  return {
    driver: ContainerDriver.of({ forHost }),
    calls,
    containers: (host = "") => [...hostState(host).containers.values()],
    volumes: (host = "") => [...hostState(host).volumes.keys()],
    /** A container something other than this server created. */
    seedContainer: (
      container: Omit<FakeContainer, "spec" | "status"> & { readonly status?: PodContainerStatus },
      host = "",
    ) =>
      hostState(host).containers.set(container.id, {
        ...container,
        status: container.status ?? "running",
        spec: null,
      }),
    seedVolume: (name: string, labels: Record<string, string>, host = "") =>
      hostState(host).volumes.set(name, labels),
    setStatus: (id: string, status: PodContainerStatus, host = "") => {
      const container = hostState(host).containers.get(id);
      if (container !== undefined) container.status = status;
    },
    failWhen: (predicate: (call: FakeCall) => boolean) => {
      failWhen = predicate;
    },
    /** A defect rather than a Docker failure, as a bug in the operation would raise. */
    dieWhen: (predicate: (call: FakeCall) => boolean) => {
      dieWhen = predicate;
    },
    execExitCode: (resolve: (call: FakeCall) => number | null) => {
      execExitCode = resolve;
    },
  };
};

export type FakeContainerDriver = ReturnType<typeof makeFakeContainerDriver>;
