import { createJob } from "@shared/testing/factories";
import { describe, expect, it } from "vitest";
import { resolveAutoApplyRecipient } from "./auto-apply";

describe("resolveAutoApplyRecipient", () => {
  it("uses mailto application links", () => {
    const job = createJob({
      applicationLink: "mailto:Jobs@Example.com?subject=Apply",
    });

    expect(resolveAutoApplyRecipient(job)).toBe("jobs@example.com");
  });

  it("falls back to emails in the application link or description", () => {
    const job = createJob({
      applicationLink: "https://example.com/apply",
      jobDescription: "Please send your CV to Hiring.Team@Example.org.",
    });

    expect(resolveAutoApplyRecipient(job)).toBe("hiring.team@example.org");
  });

  it("returns null when no application email is available", () => {
    const job = createJob({
      applicationLink: "https://example.com/apply",
      jobDescription: "Apply through the portal.",
      jobBrief: null,
    });

    expect(resolveAutoApplyRecipient(job)).toBeNull();
  });
});
