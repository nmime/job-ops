import { createJob } from "@shared/testing/factories";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAutoApplyRecipient, sendAutoApplication } from "./auto-apply";

vi.mock("@server/services/profile", () => ({
  getProfile: vi.fn().mockResolvedValue({
    basics: {
      name: "Test Candidate",
      email: "candidate@example.com",
    },
  }),
}));

afterEach(() => {
  delete process.env.AUTO_APPLY_SMTP_HOST;
  delete process.env.AUTO_APPLY_SMTP_PORT;
  delete process.env.AUTO_APPLY_SMTP_STARTTLS;
});

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

  it("uses source-provided contact emails from search integrations", () => {
    const job = createJob({
      applicationLink: "https://example.com/apply",
      emails: JSON.stringify(["Recruiting@Example.net"]),
      jobDescription: "Apply through the portal.",
    });

    expect(resolveAutoApplyRecipient(job)).toBe("recruiting@example.net");
  });

  it("chooses alternate or preferred application recipients over generic addresses", () => {
    const job = createJob({
      applicationLink: "https://example.com/apply",
      jobDescription:
        "For support email support@example.com. To apply, send your resume to jobs@example.com instead.",
    });

    expect(resolveAutoApplyRecipient(job)).toBe("jobs@example.com");
  });

  it("skips stale and no-reply addresses", () => {
    const job = createJob({
      applicationLink: "https://example.com/apply",
      jobDescription:
        "Do not reply to noreply@example.com. The old address careers-old@example.com is no longer monitored.",
      jobBrief: null,
    });

    expect(resolveAutoApplyRecipient(job)).toBeNull();
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

describe("sendAutoApplication", () => {
  it("rejects ready jobs without a resume PDF before sending", async () => {
    process.env.AUTO_APPLY_SMTP_HOST = "127.0.0.1";
    process.env.AUTO_APPLY_SMTP_PORT = "2525";
    process.env.AUTO_APPLY_SMTP_STARTTLS = "0";

    await expect(
      sendAutoApplication(
        createJob({
          applicationLink: "mailto:jobs@example.com",
          pdfPath: null,
          status: "ready",
        }),
      ),
    ).rejects.toThrow(
      "Auto-apply needs a generated or uploaded resume PDF before sending.",
    );
  });

  it("rejects stale generated PDFs before sending", async () => {
    process.env.AUTO_APPLY_SMTP_HOST = "127.0.0.1";
    process.env.AUTO_APPLY_SMTP_PORT = "2525";
    process.env.AUTO_APPLY_SMTP_STARTTLS = "0";

    await expect(
      sendAutoApplication(
        createJob({
          applicationLink: "mailto:jobs@example.com",
          pdfPath: "data/pdfs/stale.pdf",
          pdfFreshness: "stale",
          status: "ready",
        }),
      ),
    ).rejects.toThrow(
      "Auto-apply needs a current generated resume PDF or an uploaded resume PDF before sending.",
    );
  });
});
