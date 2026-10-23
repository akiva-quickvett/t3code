import type { MenuAction } from "@react-native-menu/menu";
import {
  podServiceLinks,
  podServiceShareTarget,
  type PodServiceShareTarget,
} from "@t3tools/client-runtime/state/pod-runtime";
import type { PodRuntimeSnapshot } from "@t3tools/contracts";

export type ThreadPodService = PodServiceShareTarget & { readonly name: string };

/** A phone never shares the environment host's loopback. */
export function threadPodServices(
  pod: PodRuntimeSnapshot | undefined,
): ReadonlyArray<ThreadPodService> {
  if (pod === undefined) return [];
  return podServiceLinks(pod).map((link) => ({
    name: link.name,
    ...podServiceShareTarget(link, false),
  }));
}

/**
 * Open goes to this device's browser, so a host-only service offers just Copy,
 * labelled so the URL is not mistaken for one that works here.
 */
export function buildThreadPodServicesMenuItems(
  services: ReadonlyArray<ThreadPodService>,
): MenuAction[] {
  if (services.length === 0) return [];
  return [
    {
      id: "pod-services",
      title: "Pod services",
      image: "globe",
      subactions: services.flatMap(({ name, reachLabel, reachable }) => [
        ...(reachable ? [{ id: `pod-open:${name}`, title: `Open ${name}`, image: "safari" }] : []),
        {
          id: `pod-copy:${name}`,
          title: `Copy ${name} URL`,
          ...(reachLabel === null ? {} : { subtitle: reachLabel }),
          image: "doc.on.doc",
        },
      ]),
    },
  ];
}

export function threadPodServiceMenuChoice(
  event: string,
  services: ReadonlyArray<ThreadPodService>,
): { readonly kind: "open" | "copy"; readonly service: ThreadPodService } | null {
  const kind = event.startsWith("pod-open:")
    ? "open"
    : event.startsWith("pod-copy:")
      ? "copy"
      : null;
  if (kind === null) return null;
  const service = services.find((candidate) => candidate.name === event.slice(9));
  return service === undefined ? null : { kind, service };
}
