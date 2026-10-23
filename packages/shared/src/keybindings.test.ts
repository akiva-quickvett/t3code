import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS } from "./keybindings.ts";

describe("default keybindings", () => {
  it("binds sidebar.nextNeedsYou to mod+alt+shift+n outside the terminal", () => {
    const rule = DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) => entry.command === "sidebar.nextNeedsYou",
    );
    expect(rule?.shortcut).toMatchObject({ key: "n", modKey: true, altKey: true, shiftKey: true });
    expect(rule?.whenAst).toEqual({
      type: "not",
      node: { type: "identifier", name: "terminalFocus" },
    });
    expect(
      DEFAULT_KEYBINDINGS.filter((entry) => entry.key === "mod+alt+shift+n").map(
        (entry) => entry.command,
      ),
    ).toEqual(["sidebar.nextNeedsYou"]);
  });

  it("never gives two defaults the same shortcut and context", () => {
    const bindings = DEFAULT_KEYBINDINGS.map((entry) => `${entry.key} when ${entry.when ?? ""}`);
    expect(new Set(bindings).size).toBe(bindings.length);
  });
});
