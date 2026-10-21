import type { ChatTemplateStatus } from "@t3tools/contracts";

export type ChatTemplateTone = "success" | "info" | "warning" | "error";

/** How a notify template's status reads in a client: a label and how worried to be. */
export function chatTemplateStatusSummary(status: ChatTemplateStatus): {
  readonly label: string;
  readonly tone: ChatTemplateTone;
} {
  switch (status.state) {
    case "approved":
      return status.usable
        ? { label: "Approved", tone: "success" }
        : {
            // Meta does not deliver MARKETING templates to US numbers (error 131049).
            label: `Approved as ${status.category ?? "an unknown category"}; only UTILITY is sent`,
            tone: "warning",
          };
    case "pending":
      return { label: "Pending review", tone: "info" };
    case "rejected":
      return { label: "Not approved", tone: "error" };
    case "missing":
      return { label: status.name === null ? "Not configured" : "Missing", tone: "warning" };
  }
}

/** Numbers typed one per line or separated by commas; the server validates each. */
export const splitPhoneNumbers = (text: string): ReadonlyArray<string> =>
  text
    .split(/[\n,;]/)
    .map((number) => number.trim())
    .filter((number) => number !== "");
