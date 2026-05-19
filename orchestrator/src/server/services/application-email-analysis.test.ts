import { describe, expect, it } from "vitest";
import {
  analyzeInboundApplicationEmail,
  chooseApplicationRecipient,
  extractRecipientCandidates,
  looksLikeHnCandidateReply,
} from "./application-email-analysis";

describe("application email analysis", () => {
  it("prefers an alternate application recipient from a reply", () => {
    const analysis = analyzeInboundApplicationEmail({
      subject: "Re: Backend Engineer application",
      body: "Please submit your resume to the updated application address hiring@example.com instead of the old inbox.",
    });

    expect(analysis.hasAlternateRecipient).toBe(true);
    expect(analysis.candidates[0]).toMatchObject({
      address: "hiring@example.com",
      category: "alternate_application",
    });
  });

  it("skips stale old email addresses", () => {
    const candidates = extractRecipientCandidates({
      jobDescription:
        "The old address jobs-old@example.com is no longer monitored. Apply on our website.",
    });

    expect(candidates.map((candidate) => candidate.address)).not.toContain(
      "jobs-old@example.com",
    );
  });

  it("prioritizes jobs and careers mailboxes over noreply support and info", () => {
    const recipient = chooseApplicationRecipient({
      jobDescription:
        "Questions: info@example.com or support@example.com. Do not reply to noreply@example.com. Send CV to careers@example.com for this role.",
    });

    expect(recipient?.address).toBe("careers@example.com");
  });

  it("detects HN candidate replies", () => {
    expect(
      looksLikeHnCandidateReply(
        "I'm interested in this backend role; my resume is at example.com and I have TypeScript experience.",
      ),
    ).toBe(true);
  });
});
