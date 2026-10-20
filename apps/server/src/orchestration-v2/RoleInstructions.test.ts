import { describe, expect, it } from "vite-plus/test";

import { ROLE_CLEARED_NOTE, rolePromptNote } from "./RoleInstructions.ts";

const role = { presetId: "scout", label: "Scout", instructions: "Return distilled results." };

describe("rolePromptNote", () => {
  it("prefixes the role on a provider thread's first turn only", () => {
    const first = rolePromptNote({ role, deliveredKey: undefined });
    expect(first.note).toBe(
      '<t3_role_instructions role="scout">\nReturn distilled results.\n</t3_role_instructions>',
    );
    expect(rolePromptNote({ role, deliveredKey: first.key })).toEqual({ note: "", key: first.key });
  });

  it("sends the role again when its instructions change", () => {
    const first = rolePromptNote({ role, deliveredKey: undefined });
    const edited = rolePromptNote({
      role: { ...role, instructions: "Report failures first." },
      deliveredKey: first.key,
    });
    expect(edited.note).toContain("Report failures first.");
    expect(edited.key).not.toBe(first.key);
  });

  it("retracts a cleared role once, and says nothing when there never was one", () => {
    const first = rolePromptNote({ role, deliveredKey: undefined });
    expect(rolePromptNote({ role: undefined, deliveredKey: first.key })).toEqual({
      note: ROLE_CLEARED_NOTE,
      key: undefined,
    });
    expect(rolePromptNote({ role: undefined, deliveredKey: undefined })).toEqual({
      note: "",
      key: undefined,
    });
    expect(
      rolePromptNote({ role: { ...role, instructions: "" }, deliveredKey: undefined }).note,
    ).toBe("");
  });
});
