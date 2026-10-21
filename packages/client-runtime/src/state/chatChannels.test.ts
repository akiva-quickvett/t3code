import { describe, expect, it } from "vite-plus/test";

import { chatTemplateStatusSummary, splitPhoneNumbers } from "./chatChannels.ts";

describe("chatTemplateStatusSummary", () => {
  it("only calls an approved UTILITY template ready to send", () => {
    expect(
      chatTemplateStatusSummary({
        name: "bugbot_notice",
        state: "approved",
        category: "UTILITY",
        usable: true,
      }),
    ).toEqual({ label: "Approved", tone: "success" });
    expect(
      chatTemplateStatusSummary({
        name: "bugbot_notice",
        state: "approved",
        category: "MARKETING",
        usable: false,
      }).tone,
    ).toBe("warning");
    expect(
      chatTemplateStatusSummary({ name: null, state: "missing", category: null, usable: false })
        .label,
    ).toBe("Not configured");
  });
});

describe("splitPhoneNumbers", () => {
  it("splits on lines, commas and semicolons and drops blanks", () => {
    expect(splitPhoneNumbers("+1 555 0142,\n +1 555 0143; ;")).toEqual([
      "+1 555 0142",
      "+1 555 0143",
    ]);
  });
});
