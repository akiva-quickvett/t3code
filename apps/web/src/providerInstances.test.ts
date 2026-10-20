import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderEntriesByEnvironment,
  deriveProviderInstanceEntries,
  filterProviderInstancesForLock,
  getDefaultProviderInstanceModel,
  isProviderInstanceAllowedByLock,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  resolveProviderCatalogAvailability,
  resolveProviderInstanceLock,
  resolveProviderInstanceSwitchNote,
  resolveSelectableProviderInstance,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
  supportsTextGeneration?: boolean;
  continuation?: ServerProvider["continuation"];
  workspace?: { readonly id: string; readonly label?: string };
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.continuation ? { continuation: input.continuation } : {}),
    auth: {
      status: "authenticated",
      ...(input.workspace?.id ? { workspaceId: input.workspace.id } : {}),
      ...(input.workspace?.label ? { workspaceLabel: input.workspace.label } : {}),
    },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("isProviderInstancePickerReady", () => {
  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });

  it("accepts an enabled, available, ready instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);

    expect(entry && isProviderInstancePickerReady(entry)).toBe(true);
  });
});

describe("resolveProviderCatalogAvailability", () => {
  const [entry] = deriveProviderInstanceEntries([
    provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
  ]);

  it("keeps the initial reactive config state distinct from an empty catalogue", () => {
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: false,
        entries: [],
        selectedEntry: undefined,
      }),
    ).toBe("loading");
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: true,
        entries: [],
        selectedEntry: undefined,
      }),
    ).toBe("unconfigured");
  });

  it("distinguishes a selected provider from configured but unusable providers", () => {
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: true,
        entries: entry ? [entry] : [],
        selectedEntry: entry,
      }),
    ).toBe("ready");
    expect(
      resolveProviderCatalogAvailability({
        catalogLoaded: true,
        entries: entry ? [entry] : [],
        selectedEntry: undefined,
      }),
    ).toBe("unavailable");
  });
});

describe("isProviderInstancePickerVisible", () => {
  it("keeps enabled instances in the rail and removes disabled instances", () => {
    const [enabledEntry, disabledEntry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        enabled: false,
      }),
    ]);

    expect(enabledEntry && isProviderInstancePickerVisible(enabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerVisible(disabledEntry)).toBe(false);
  });
});

describe("applyProviderInstanceSettings", () => {
  it("uses settings when a streamed snapshot still reports a disabled default as enabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed custom instance snapshot as disabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_work",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {},
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.enabled).toBe(false);
  });

  it.each(["constructor", "toString"])(
    "treats a removed custom instance named %s as disabled",
    (instanceId) => {
      const entries = deriveProviderInstanceEntries([
        provider({
          provider: ProviderDriverKind.make("claudeAgent"),
          instanceId,
        }),
      ]);
      const [entry] = applyProviderInstanceSettings(
        entries,
        {
          providerInstances: {},
          projectSettingsOverrides: {},
        },
        null,
      );

      expect(entry?.enabled).toBe(false);
    },
  );

  it("uses settings for a configured custom instance named constructor", () => {
    const instanceId = ProviderInstanceId.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId,
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed default instance for a fork driver as disabled", () => {
    const driver = ProviderDriverKind.make("constructor");
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: driver,
        instanceId: "constructor",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {},
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(entry?.isDefault).toBe(true);
    expect(entry?.enabled).toBe(false);
  });

  it("uses the driver default for an unconfigured built-in default instance", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
      provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok", enabled: true }),
    ]);
    const [codex, grok] = applyProviderInstanceSettings(
      entries,
      {
        providerInstances: {},
        projectSettingsOverrides: {},
      },
      null,
    );

    expect(codex?.enabled).toBe(true);
    expect(grok?.enabled).toBe(false);
  });
});

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("deriveProviderEntriesByEnvironment", () => {
  it("resolves registry branding from each environment's settings", () => {
    const instanceId = "custom-acp";
    const snapshot = provider({ provider: ProviderDriverKind.make("acpRegistry"), instanceId });
    const byEnvironment = deriveProviderEntriesByEnvironment(
      ["devin", "other-agent"].map(
        (agentId) =>
          [
            agentId,
            [snapshot],
            {
              providerInstances: {
                [instanceId]: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  enabled: true,
                  config: { agentId, registryIconUrl: `https://example.com/${agentId}.svg` },
                },
              },
              projectSettingsOverrides: {},
            },
          ] as const,
      ),
    );
    expect(byEnvironment.get("devin")?.get(instanceId)?.acpRegistryAgentId).toBe("devin");
    expect(byEnvironment.get("devin")?.get(instanceId)?.acpRegistryIconUrl).toBe(
      "https://example.com/devin.svg",
    );
    expect(byEnvironment.get("other-agent")?.get(instanceId)?.acpRegistryAgentId).toBe(
      "other-agent",
    );
  });

  it("keeps same-id default instances distinct per environment", () => {
    const byEnvironment = deriveProviderEntriesByEnvironment([
      [
        "local",
        [
          provider({
            provider: ProviderDriverKind.make("claude"),
            instanceId: "claude",
            displayName: "Claude Local",
            accentColor: "#112233",
          }),
        ],
      ],
      [
        "remote",
        [
          provider({
            provider: ProviderDriverKind.make("claude"),
            instanceId: "claude",
            displayName: "Claude Remote",
            accentColor: "#445566",
          }),
        ],
      ],
    ]);

    expect(byEnvironment.get("local")?.get("claude")?.displayName).toBe("Claude Local");
    expect(byEnvironment.get("local")?.get("claude")?.accentColor).toBe("#112233");
    expect(byEnvironment.get("remote")?.get("claude")?.displayName).toBe("Claude Remote");
    expect(byEnvironment.get("remote")?.get("claude")?.accentColor).toBe("#445566");
  });

  it("never falls back to another environment's instances", () => {
    const byEnvironment = deriveProviderEntriesByEnvironment([
      ["local", [provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" })]],
      ["empty", []],
    ]);

    expect(byEnvironment.get("empty")?.get("codex")).toBeUndefined();
    expect(byEnvironment.get("empty")?.size).toBe(0);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("claude_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("prefers a ready instance over an enabled one whose driver cannot start", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const ready = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: ready }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(ready);
  });

  it("prefers an unprobed (warning) instance over one whose probe errored", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const unprobed = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unprobed,
        status: "warning",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(unprobed);
  });

  it("keeps a requested instance even when its probe errored", () => {
    const requested = ProviderInstanceId.make("codex");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: requested,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("does not invent an errored instance as a new-user default", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBeUndefined();
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("codex");
    const unavailable = ProviderInstanceId.make("claudeAgent");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("getDefaultProviderInstanceModel", () => {
  it("uses the instance's own models, not the default instance of the kind", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: [model("openai/gpt-5.5", true), model("claude-opus-4-8")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5")],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claude_openrouter")),
    ).toBe("claude-opus-4-8");
  });

  it("falls back to the driver default when the instance reports no models", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    const resolved = getDefaultProviderInstanceModel(
      providers,
      ProviderInstanceId.make("claudeAgent"),
    );
    expect(typeof resolved).toBe("string");
    expect(resolved?.length).toBeGreaterThan(0);
  });

  it("honors the instance's declared default before model-list order", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5"), model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claudeAgent"))).toBe(
      "claude-opus-4-8",
    );
  });

  it("returns undefined for an unknown instance", () => {
    expect(
      getDefaultProviderInstanceModel([], ProviderInstanceId.make("removed_instance")),
    ).toBeUndefined();
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  it.each([
    ["codex", "codex", "gpt-5.6"],
    ["claudeAgent", "claudeAgent", "claude-fable-5"],
    ["cursor", "cursor", "composer-2"],
  ])("uses the only available %s instance", (driver, instanceId, modelSlug) => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make(driver),
        instanceId,
        models: [model(modelSlug, false, true)],
      }),
    ];

    expect(resolveDefaultProviderModelSelection(providers, null)).toEqual({
      instanceId,
      model: modelSlug,
    });
  });

  it("preserves a valid stored selection including its options", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-opus-4-8")],
      }),
    ];
    const stored = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "custom-model",
      options: [{ id: "effort", value: "high" }],
    };

    expect(resolveDefaultProviderModelSelection(providers, stored)).toBe(stored);
  });

  it("replaces a stale stored instance with the first ready instance and its model", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        status: "warning",
        models: [model("gpt-5.6")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(
      resolveDefaultProviderModelSelection(providers, {
        instanceId: ProviderInstanceId.make("removed-provider"),
        model: "stale-model",
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-4-8" });
  });

  it.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "replaces an unavailable stored instance deterministically",
    (requestedState) => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make("codex"),
          instanceId: "codex",
          models: [model("gpt-5.6")],
          ...requestedState,
        }),
        provider({
          provider: ProviderDriverKind.make("claudeAgent"),
          instanceId: "claudeAgent",
          models: [model("claude-opus-4-8", false, true)],
        }),
      ];

      expect(
        resolveDefaultProviderModelSelection(providers, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6",
        }),
      ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-4-8" });
    },
  );

  it("returns no selection for empty, disabled, unavailable, or error-only profiles", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            enabled: false,
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            availability: "unavailable",
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            status: "error",
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});

describe("provider icon metadata", () => {
  it("clears stale registry branding when an instance switches to a local command", () => {
    const instanceId = ProviderInstanceId.make("custom-acp");
    const driver = ProviderDriverKind.make("acpRegistry");
    const iconUrl = "https://cdn.agentclientprotocol.com/registry/icons/swe-agent.svg";
    const snapshots = deriveProviderInstanceEntries([
      { ...provider({ provider: driver, instanceId }), iconUrl },
    ]);
    const registryConfig = { agentId: "swe-agent", registryIconUrl: iconUrl };
    const brandedEntries = applyProviderInstanceSettings(
      snapshots,
      {
        providerInstances: { [instanceId]: { driver, enabled: true, config: registryConfig } },
        projectSettingsOverrides: {},
      },
      null,
    );
    expect(brandedEntries[0]?.acpRegistryAgentId).toBe("swe-agent");
    expect(brandedEntries[0]?.acpRegistryIconUrl).toBe(iconUrl);

    const [localEntry] = applyProviderInstanceSettings(
      brandedEntries,
      {
        providerInstances: {
          [instanceId]: {
            driver,
            enabled: false,
            config: { ...registryConfig, source: "local", commandPath: "dsh" },
          },
        },
        projectSettingsOverrides: {},
      },
      null,
    );
    expect(localEntry?.acpRegistryAgentId).toBeUndefined();
    expect(localEntry?.acpRegistryIconUrl).toBeUndefined();
    expect(localEntry?.enabled).toBe(false);
    expect(localEntry?.snapshot).toBe(snapshots[0]?.snapshot);

    const [restoredEntry] = applyProviderInstanceSettings(
      localEntry ? [localEntry] : [],
      {
        providerInstances: { [instanceId]: { driver, enabled: true, config: registryConfig } },
        projectSettingsOverrides: {},
      },
      null,
    );
    expect(restoredEntry?.acpRegistryAgentId).toBe("swe-agent");
    expect(restoredEntry?.acpRegistryIconUrl).toBe(iconUrl);
    expect(restoredEntry?.enabled).toBe(true);
  });

  it("retains server-published registry icons without local settings", () => {
    const iconUrl = "https://cdn.agentclientprotocol.com/registry/icons/swe-agent.svg";
    const [entry] = deriveProviderInstanceEntries([
      {
        ...provider({ provider: ProviderDriverKind.make("acpRegistry"), instanceId: "swe-remote" }),
        iconUrl,
      },
    ]);
    expect(entry?.acpRegistryIconUrl).toBe(iconUrl);
    expect(entry?.driverKind).toBe("acpRegistry");
  });
});

describe("provider instance lock", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");
  const antigravity = ProviderDriverKind.make("antigravity");

  const entryOf = (
    driver: ProviderDriverKind,
    instanceId: string,
    groupKey?: string,
    workspace?: { readonly id: string; readonly label?: string },
  ) =>
    deriveProviderInstanceEntries([
      provider({
        provider: driver,
        instanceId,
        ...(groupKey ? { continuation: { groupKey } } : {}),
        ...(workspace ? { workspace } : {}),
      }),
    ])[0]!;

  const claudeWork = entryOf(claude, "claude_work", "claude:work", { id: "org-a", label: "Acme" });
  const claudeWorkAlias = entryOf(claude, "claude_work_alias", "claude:work");
  const claudePersonal = entryOf(claude, "claude_personal", "claude:personal", { id: "org-b" });
  const claudeSide = entryOf(claude, "claude_side", "claude:side");
  const codexWork = entryOf(codex, "codex_work", "codex:work");
  const codexPersonal = entryOf(codex, "codex_personal", "codex:personal");
  const entries = [
    claudeWork,
    claudeWorkAlias,
    claudePersonal,
    claudeSide,
    codexWork,
    codexPersonal,
  ];

  const lockOn = (locked: (typeof entries)[number], lockEntries = entries) =>
    resolveProviderInstanceLock({
      entries: lockEntries,
      lockedProvider: locked.driverKind,
      lockedInstanceId: locked.instanceId,
    });

  it("leaves an unlocked thread free to pick any instance", () => {
    const lock = resolveProviderInstanceLock({
      entries,
      lockedProvider: null,
      lockedInstanceId: claudeWork.instanceId,
    });

    expect(lock).toBeNull();
    expect(entries.every((entry) => isProviderInstanceAllowedByLock(lock, entry))).toBe(true);
    expect(filterProviderInstancesForLock(entries, lock, undefined)).toEqual(entries);
  });

  it("lets a Claude thread resume in its group and hand off to another Claude group", () => {
    const lock = lockOn(claudeWork);

    expect(lock?.continuationGroupKey).toBe("claude:work");
    expect(
      entries
        .filter((entry) => isProviderInstanceAllowedByLock(lock, entry))
        .map((e) => e.instanceId),
    ).toEqual([
      claudeWork.instanceId,
      claudeWorkAlias.instanceId,
      claudePersonal.instanceId,
      claudeSide.instanceId,
    ]);
  });

  it("keeps a Codex thread in its continuation group", () => {
    const lock = lockOn(codexWork);

    expect(isProviderInstanceAllowedByLock(lock, codexWork)).toBe(true);
    expect(isProviderInstanceAllowedByLock(lock, codexPersonal)).toBe(false);
    expect(isProviderInstanceAllowedByLock(lock, claudeWork)).toBe(false);
  });

  it("limits a group-less Antigravity thread to its exact instance", () => {
    const googleWork = entryOf(antigravity, "google_work");
    const googlePersonal = entryOf(antigravity, "google_personal");
    const lock = lockOn(googleWork, [googleWork, googlePersonal]);

    expect(lock?.continuationGroupKey).toBeNull();
    expect(isProviderInstanceAllowedByLock(lock, googleWork)).toBe(true);
    expect(isProviderInstanceAllowedByLock(lock, googlePersonal)).toBe(false);
    expect(
      filterProviderInstancesForLock([googleWork, googlePersonal], lock, googlePersonal.instanceId),
    ).toEqual([googleWork]);
  });

  it("lets only the requested instance be a handoff target", () => {
    const lock = lockOn(claudeWork);

    expect(filterProviderInstancesForLock(entries, lock, claudePersonal.instanceId)).toEqual([
      claudeWork,
      claudeWorkAlias,
      claudePersonal,
    ]);
    expect(filterProviderInstancesForLock(entries, lock, undefined)).toEqual([
      claudeWork,
      claudeWorkAlias,
    ]);
    expect(filterProviderInstancesForLock(entries, lock, codexPersonal.instanceId)).toEqual([
      claudeWork,
      claudeWorkAlias,
    ]);
  });

  it("lets a Claude thread whose instance is missing move only by an explicit handoff", () => {
    const lock = resolveProviderInstanceLock({
      entries,
      lockedProvider: claude,
      lockedInstanceId: ProviderInstanceId.make("claude_deleted"),
    });

    expect(lock?.continuationGroupKey).toBeNull();
    expect(isProviderInstanceAllowedByLock(lock, claudePersonal)).toBe(true);
    expect(isProviderInstanceAllowedByLock(lock, codexWork)).toBe(false);
    expect(filterProviderInstancesForLock(entries, lock, undefined)).toEqual([]);
    expect(filterProviderInstancesForLock(entries, lock, claudePersonal.instanceId)).toEqual([
      claudePersonal,
    ]);
  });

  it("lets a group-less thread of a non-handoff driver resume in any instance of its driver", () => {
    const lock = resolveProviderInstanceLock({
      entries,
      lockedProvider: codex,
      lockedInstanceId: ProviderInstanceId.make("codex_deleted"),
    });

    expect(filterProviderInstancesForLock(entries, lock, undefined)).toEqual([
      codexWork,
      codexPersonal,
    ]);
  });

  describe("resolveProviderInstanceSwitchNote", () => {
    it("labels a move to another Claude group as a handoff", () => {
      expect(resolveProviderInstanceSwitchNote(claudeWork, claudeSide)).toEqual({
        label: "Starts a new Claude session with a context handoff",
        organizationWarning: null,
      });
    });

    it("says nothing for a resume in the same group, the same instance, or no current instance", () => {
      expect(resolveProviderInstanceSwitchNote(claudeWork, claudeWorkAlias)).toBeNull();
      expect(resolveProviderInstanceSwitchNote(claudeWork, claudeWork)).toBeNull();
      expect(resolveProviderInstanceSwitchNote(undefined, claudePersonal)).toBeNull();
    });

    it("labels a move from a Claude instance without a group to another instance", () => {
      expect(
        resolveProviderInstanceSwitchNote(entryOf(claude, "claude_ungrouped"), claudePersonal)
          ?.label,
      ).toBe("Starts a new Claude session with a context handoff");
    });

    it("says nothing for drivers that never hand off", () => {
      expect(resolveProviderInstanceSwitchNote(codexWork, codexPersonal)).toBeNull();
      expect(resolveProviderInstanceSwitchNote(codexWork, claudePersonal)).toBeNull();
    });

    it("warns only when both organizations are known and differ", () => {
      expect(
        resolveProviderInstanceSwitchNote(claudePersonal, claudeWork)?.organizationWarning,
      ).toBe("Acme: earlier reasoning won't carry over");
      expect(
        resolveProviderInstanceSwitchNote(claudeWork, claudePersonal)?.organizationWarning,
      ).toBe("Another organization: earlier reasoning won't carry over");
      expect(
        resolveProviderInstanceSwitchNote(
          claudeWork,
          entryOf(claude, "claude_work_2", "claude:work-2", { id: "org-a" }),
        )?.organizationWarning,
      ).toBeNull();
      expect(
        resolveProviderInstanceSwitchNote(claudeWork, claudeSide)?.organizationWarning,
      ).toBeNull();
      expect(
        resolveProviderInstanceSwitchNote(claudeSide, claudeWork)?.organizationWarning,
      ).toBeNull();
    });
  });
});
