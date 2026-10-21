import {
  type EffectiveAgentRolePreset,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const PROJECT_DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";

const testState = vi.hoisted(() => {
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} as Record<string, string> }],
    },
    navigate: async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
      router.state.matches = [{ params: { draftId: request.params.draftId } }];
    },
  };
  let nextDraft = 0;
  return {
    router,
    nextDraftId: () => `draft-${++nextDraft}`,
    reset() {
      nextDraft = 0;
      router.state.location.href = "/";
      router.state.matches = [{ params: {} }];
    },
  };
});

const project = {
  id: "project-1",
  environmentId: "environment-1",
  workspaceRoot: "/projects/one",
  defaultThreadEnvMode: null,
  defaultModelSelection: null,
};

vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        [
          "environment-1",
          {
            settings: {
              defaultThreadEnvMode: "local",
              newWorktreesStartFromOrigin: false,
              defaultModelSelection: null,
              defaultRuntimeMode: PROJECT_DEFAULT_RUNTIME_MODE,
            },
          },
        ],
      ]),
  },
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: (settings: Record<string, unknown>) => ({
    settings,
    sources: {},
    overrides: {},
  }),
  resolveNewThreadEnvMode: () => "local",
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({ readT3ProjectFile: async () => null }));
vi.mock("../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/utils")>()),
  newDraftId: () => testState.nextDraftId(),
  newThreadId: () => `thread-${testState.router.state.location.href}`,
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project-key",
  getProjectOrderKey: () => "project-key",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProject: () => project,
  readProjects: () => [project],
  readThreadShell: () => null,
  readThreadShells: () => [],
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "project-key",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useComposerDraftStore } from "../composerDraftStore";
import { applyRolePresetToDraft } from "../lib/rolePresetDraft";
import { useNewThreadHandler } from "./useHandleNewThread";

const STICKY = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const projectRef = { environmentId: "environment-1", projectId: "project-1" } as never;

const wide: EffectiveAgentRolePreset = {
  id: "wide",
  label: "Wide",
  target: {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [],
  },
  runtimeMode: "full-access",
  interactionMode: "plan",
  instructions: "Work broadly.",
  source: "environment",
  inherited: false,
  resolvedModelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
  },
  unavailable: null,
};

const resetStore = () =>
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: { [STICKY.instanceId]: STICKY },
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: STICKY.instanceId,
  });

/** What the composer would show: its own override first, then the draft's context. */
const effective = (draftId: string) => {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId as never);
  const composer = store.getComposerDraft(draftId as never);
  const provider = composer?.activeProvider;
  return {
    rolePreset: session?.rolePreset ?? null,
    runtimeMode: composer?.runtimeMode ?? session?.runtimeMode,
    interactionMode: composer?.interactionMode ?? session?.interactionMode,
    model: provider ? composer?.modelSelectionByProvider[provider]?.model : undefined,
  };
};

describe("a plain new thread after a role was applied to the draft", () => {
  beforeEach(() => {
    testState.reset();
    resetStore();
  });
  afterEach(resetStore);

  it.each([
    ["from the role draft itself", true],
    ["from another page", false],
  ])("drops the role, its modes and its model %s", async (_, stayOnDraft) => {
    const opened = await useNewThreadHandler()(projectRef);
    applyRolePresetToDraft(opened!.draftId, wide);
    expect(effective(opened!.draftId)).toEqual({
      rolePreset: { id: "wide", label: "Wide" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      model: "claude-opus-5-5",
    });

    if (!stayOnDraft) {
      testState.router.state.location.href = "/settings";
      testState.router.state.matches = [{ params: {} }];
    }
    const reopened = await useNewThreadHandler()(projectRef);

    expect(reopened?.draftId).toBe(opened!.draftId);
    expect(effective(opened!.draftId)).toEqual({
      rolePreset: null,
      runtimeMode: PROJECT_DEFAULT_RUNTIME_MODE,
      interactionMode: "default",
      model: STICKY.model,
    });
  });
});
