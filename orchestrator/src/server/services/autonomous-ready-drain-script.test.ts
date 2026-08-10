import type { Job } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
  classifyReadyDrainCandidate,
  isExplicitReviewOnlyMutationEnabled,
  selectReadyDrainBatch,
} from "./autonomous-ready-drain-selection";

function makeReadyJob(overrides: Partial<Job>): Job {
  return {
    id: overrides.id ?? "job-id",
    source: overrides.source ?? "ashby",
    sourceJobId: null,
    jobUrlDirect: null,
    datePosted: null,
    title: overrides.title ?? "Software Engineer",
    employer: overrides.employer ?? "Example Co",
    employerUrl: null,
    jobUrl: overrides.jobUrl ?? "https://example.com/jobs/1",
    applicationLink: overrides.applicationLink ?? null,
    disciplines: null,
    deadline: null,
    salary: null,
    location: null,
    locationEvidence: null,
    degreeRequired: null,
    starting: null,
    jobDescription: overrides.jobDescription ?? null,
    status: "ready",
    outcome: null,
    closedAt: null,
    suitabilityScore: null,
    suitabilityReason: null,
    jobBrief: overrides.jobBrief ?? null,
    tailoredSummary: null,
    tailoredHeadline: null,
    tailoredSkills: null,
    selectedProjectIds: null,
    pdfPath: "/tmp/resume.pdf",
    pdfSource: "generated",
    pdfRegenerating: false,
    pdfFreshness: "current",
    pdfFingerprint: null,
    pdfGeneratedAt: null,
    tracerLinksEnabled: false,
    sponsorMatchScore: null,
    sponsorMatchNames: null,
    jobType: null,
    salarySource: null,
    salaryInterval: null,
    salaryMinAmount: null,
    salaryMaxAmount: null,
    salaryCurrency: null,
    isRemote: null,
    jobLevel: null,
    jobFunction: null,
    listingType: null,
    emails: overrides.emails ?? null,
    companyIndustry: null,
    companyLogo: null,
    companyUrlDirect: null,
    companyAddresses: null,
    companyNumEmployees: null,
    companyRevenue: null,
    companyDescription: null,
    skills: null,
    experienceRange: null,
    companyRating: null,
    companyReviewsCount: null,
    vacancyCount: null,
    workFromHomeType: null,
    discoveredAt: overrides.discoveredAt ?? "2026-06-07T08:00:00.000Z",
    processedAt: null,
    readyAt: overrides.readyAt ?? "2026-06-07T08:00:00.000Z",
    appliedAt: null,
    createdAt: overrides.createdAt ?? "2026-06-07T08:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-07T08:00:00.000Z",
    ...overrides,
  };
}

describe("autonomous ready-drain selection", () => {
  it("keeps batch limit bounded to three while preferring email, then allowed portals, then review-only blockers", () => {
    const newestReviewOnly = makeReadyJob({
      id: "review-only-newest",
      applicationLink: "https://boards.greenhouse.io/acme/jobs/1",
      readyAt: "2026-06-07T12:00:00.000Z",
    });
    const olderAllowedPortal = makeReadyJob({
      id: "allowed-ashby-older",
      applicationLink: "https://jobs.ashbyhq.com/acme/application/1",
      readyAt: "2026-06-07T09:00:00.000Z",
    });
    const olderEmail = makeReadyJob({
      id: "email-oldest",
      applicationLink: "mailto:jobs@example.com",
      readyAt: "2026-06-07T08:00:00.000Z",
    });
    const newerAllowedPortal = makeReadyJob({
      id: "allowed-ashby-newer",
      applicationLink: "https://acme.jobs.ashbyhq.com/application/2",
      readyAt: "2026-06-07T10:00:00.000Z",
    });

    expect(
      selectReadyDrainBatch(
        [newestReviewOnly, olderAllowedPortal, olderEmail, newerAllowedPortal],
        99,
        {
          hasEmailReady: (job) =>
            job.applicationLink?.startsWith("mailto:") ?? false,
        },
      ).map((job) => job.id),
    ).toEqual(["email-oldest", "allowed-ashby-newer", "allowed-ashby-older"]);
  });

  it("classifies unallowlisted portals as review-only allowlist blockers without the explicit mutation flag", () => {
    const candidate = classifyReadyDrainCandidate(
      makeReadyJob({
        id: "blocked-greenhouse",
        applicationLink: "https://boards.greenhouse.io/acme/jobs/1",
      }),
    );

    expect(candidate).toMatchObject({
      route: "review_only",
      priority: 2,
      blockerBucket: "allowlist_policy",
      blockerReason: "domain_not_allowlisted",
      reasonCode: "portal_blocked_domain_not_validated",
    });
    expect(isExplicitReviewOnlyMutationEnabled({})).toBe(false);
  });

  it("uses the existing portal allowlist env fallback policy for direct portal priority", () => {
    const previousAutonomousAllowlist =
      process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS;
    const previousFullAutoAllowlist =
      process.env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS;
    try {
      delete process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS;
      process.env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS = "greenhouse.io";

      expect(
        classifyReadyDrainCandidate(
          makeReadyJob({
            id: "allowed-from-fallback",
            applicationLink: "https://boards.greenhouse.io/acme/jobs/1",
          }),
        ),
      ).toMatchObject({
        route: "allowed_portal_domain",
        priority: 1,
      });
    } finally {
      if (previousAutonomousAllowlist === undefined) {
        delete process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS;
      } else {
        process.env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS =
          previousAutonomousAllowlist;
      }
      if (previousFullAutoAllowlist === undefined) {
        delete process.env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS;
      } else {
        process.env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS =
          previousFullAutoAllowlist;
      }
    }
  });
});
