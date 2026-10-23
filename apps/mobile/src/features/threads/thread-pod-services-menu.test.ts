import { PodRuntimeId, type PodRuntimeSnapshot, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadPodServicesMenuItems,
  threadPodServiceMenuChoice,
  threadPodServices,
} from "./thread-pod-services-menu";

const pod = (services: PodRuntimeSnapshot["services"]): PodRuntimeSnapshot => ({
  id: PodRuntimeId.make("pod-one"),
  projectId: ProjectId.make("project-1"),
  worktreePath: "/work/trees/feature",
  state: "running",
  services,
  image: "image",
  startedAt: null,
  lastError: null,
  containerIds: [],
  volumeIds: [],
  updatedAt: "t",
});

describe("thread pod services menu", () => {
  it("opens reachable services on the phone and only copies host-only ones", () => {
    const services = threadPodServices(
      pod([
        {
          name: "web",
          port: 3000,
          url: "http://127.0.0.1:20000",
          tailnetUrl: "http://100.64.0.1:20000",
        },
        { name: "api", port: 8000, url: "http://127.0.0.1:20001" },
        { name: "db", port: 5432, url: null },
      ]),
    );
    const [menu] = buildThreadPodServicesMenuItems(services);
    expect(menu?.subactions?.map((action) => [action.id, action.title, action.subtitle])).toEqual([
      ["pod-open:web", "Open web", undefined],
      ["pod-copy:web", "Copy web URL", "tailnet"],
      ["pod-copy:api", "Copy api URL", "host only"],
    ]);
    expect(threadPodServiceMenuChoice("pod-open:web", services)).toMatchObject({
      kind: "open",
      service: { url: "http://100.64.0.1:20000" },
    });
    expect(threadPodServiceMenuChoice("pod-copy:api", services)).toMatchObject({
      kind: "copy",
      service: { url: "http://127.0.0.1:20001" },
    });
    expect(threadPodServiceMenuChoice("copy-thread-id", services)).toBeNull();
  });

  it("adds nothing for a host thread or a pod with nothing published", () => {
    expect(buildThreadPodServicesMenuItems(threadPodServices(undefined))).toEqual([]);
    expect(
      buildThreadPodServicesMenuItems(
        threadPodServices(pod([{ name: "web", port: 3000, url: null }])),
      ),
    ).toEqual([]);
  });
});
