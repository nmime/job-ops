import type { FreelanceFinderContext } from "job-ops-shared/types/freelance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setWantapplyFetchSeamForTests,
  applyToWantapplyGig,
  exportBatchToWantapply,
  type FetchSeam,
  findWantapplyGigs,
  mapJobToGig,
  type RawResponse,
  stripHtml,
  type WantapplyJob,
  wantapplyJobsUrl,
} from "../src/main";
import fixtures from "./fixtures/jobs.json";

const [kleos, appercut, arival] = fixtures as unknown as WantapplyJob[];

function makeCtx(
  overrides: Partial<FreelanceFinderContext> = {},
): FreelanceFinderContext {
  return {
    platform: "wantapply",
    searchTerms: [],
    selectedCountry: "",
    settings: {},
    ...overrides,
  };
}

function pageBody(jobs: unknown[], hasNextPage: boolean): RawResponse {
  return {
    status: 200,
    body: JSON.stringify({ data: jobs, hasNextPage, total: jobs.length }),
  };
}

type SeamCalls = {
  direct: number;
  browserLaunches: number;
  browserGets: string[];
};

function makeSeam(opts: {
  direct?: (url: string) => RawResponse | Promise<RawResponse>;
  browserPages?: Record<string, RawResponse>;
  browserFails?: boolean;
}): { seam: FetchSeam; calls: SeamCalls } {
  const calls: SeamCalls = { direct: 0, browserLaunches: 0, browserGets: [] };
  const seam: FetchSeam = {
    async direct(url) {
      calls.direct++;
      if (!opts.direct) throw new Error("direct transport not configured");
      return opts.direct(url);
    },
    async browser() {
      calls.browserLaunches++;
      return {
        async get(url: string): Promise<RawResponse> {
          calls.browserGets.push(url);
          if (opts.browserFails) {
            return { status: 403, body: "<html>Just a moment...</html>" };
          }
          return opts.browserPages?.[url] ?? { status: 404, body: "not found" };
        },
        async close(): Promise<void> {},
      };
    },
  };
  return { seam, calls };
}

beforeEach(() => {
  __setWantapplyFetchSeamForTests(null);
});

afterEach(() => {
  __setWantapplyFetchSeamForTests(null);
  vi.unstubAllEnvs();
});

describe("stripHtml", () => {
  it("converts block tags to newlines and decodes entities", () => {
    expect(
      stripHtml("<p>Hello&nbsp;world</p><br><p>Second &amp; third</p>"),
    ).toBe("Hello world\n\nSecond & third");
  });

  it("strips inline tags and keeps paragraph breaks", () => {
    const out = stripHtml("<h2><strong>Title</strong></h2><p>Body</p>");
    expect(out).toBe("Title\n\nBody");
    expect(stripHtml("")).toBe("");
  });
});

describe("wantapplyJobsUrl", () => {
  it("encodes the tech-domain filters payload", () => {
    const url = wantapplyJobsUrl("node.js", 2);
    expect(
      url.startsWith("https://wantapply.com/api/jobs?page=2&filters="),
    ).toBe(true);
    const filters = decodeURIComponent(
      new URL(url).searchParams.get("filters") as string,
    );
    expect(JSON.parse(filters)).toEqual({ domain: "tech", search: "node.js" });
  });
});

describe("mapJobToGig", () => {
  it("maps a CTO listing (remote, no salary, no locations)", () => {
    const gig = mapJobToGig(kleos);
    expect(gig.sourceGigId).toBe(kleos.id);
    expect(gig.title).toBe("Chief Technology Officer (CTO)");
    expect(gig.clientOrEmployer).toBe("Kleos");
    expect(gig.gigUrl).toBe(
      "https://wantapply.com/chief-technology-officer-cto-at-kleos",
    );
    expect(gig.applicationLink).toBe(gig.gigUrl);
    expect(gig.isRemote).toBe(true);
    expect(gig.jobType).toBe("Fulltime · Chief");
    expect(gig.location).toBeUndefined();
    expect(gig.budget).toBeUndefined();
    expect(gig.datePosted).toBe("2026-08-07T10:10:01.143Z");
    expect(gig.gigDescription).toContain("About Kleos");
    expect(gig.gigDescription).not.toContain("<");
  });

  it("maps salary strings and junior level", () => {
    const gig = mapJobToGig(appercut);
    expect(gig.clientOrEmployer).toBe("Appercut");
    expect(gig.budget).toBe("$1100-1400 gross");
    expect(gig.jobType).toBe("Fulltime · Junior");
    expect(gig.isRemote).toBe(true);
  });

  it("combines region and country names into location", () => {
    const gig = mapJobToGig(arival);
    expect(gig.clientOrEmployer).toBe("Arival Bank");
    expect(gig.location).toBe("Worldwide, Cyprus");
    expect(gig.isRemote).toBe(true);
    expect(gig.jobType).toBe("Fulltime · Senior");
  });
});

describe("findWantapplyGigs", () => {
  it("paginates through the direct API until hasNextPage=false", async () => {
    const p1 = pageBody([kleos, appercut], true);
    const p2 = pageBody([arival], false);
    const { seam, calls } = makeSeam({
      direct: (url) => (url.includes("page=1") ? p1 : p2),
    });
    __setWantapplyFetchSeamForTests(seam);

    const res = await findWantapplyGigs(makeCtx());

    expect(res.success).toBe(true);
    expect(res.gigs).toHaveLength(3);
    expect(calls.direct).toBe(2);
    expect(calls.browserLaunches).toBe(0);
  });

  it("falls back to the stealth browser when Cloudflare challenges direct fetch", async () => {
    const p1 = pageBody([kleos, appercut], true);
    const p2 = pageBody([arival], false);
    const { seam, calls } = makeSeam({
      direct: () => ({ status: 403, body: "<html>Just a moment...</html>" }),
      browserPages: {
        [wantapplyJobsUrl("", 1)]: p1,
        [wantapplyJobsUrl("", 2)]: p2,
      },
    });
    __setWantapplyFetchSeamForTests(seam);

    const res = await findWantapplyGigs(makeCtx());

    expect(res.success).toBe(true);
    expect(res.gigs).toHaveLength(3);
    expect(calls.direct).toBe(1); // one probe, then tier switch
    expect(calls.browserLaunches).toBe(1); // single launch reused across pages
    expect(calls.browserGets).toHaveLength(2);
  });

  it("dedupes jobs repeated across pages", async () => {
    const p1 = pageBody([kleos, appercut], true);
    const p2 = pageBody([kleos, arival], false);
    const { seam } = makeSeam({
      direct: (url) => (url.includes("page=1") ? p1 : p2),
    });
    __setWantapplyFetchSeamForTests(seam);

    const res = await findWantapplyGigs(makeCtx());

    expect(res.success).toBe(true);
    expect(res.gigs).toHaveLength(3);
    const ids = res.gigs.map((g) => g.sourceGigId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns a structured failure when both tiers fail (no throw)", async () => {
    const { seam } = makeSeam({
      direct: async () => {
        throw new Error("network down");
      },
      browserFails: true,
    });
    __setWantapplyFetchSeamForTests(seam);

    const res = await findWantapplyGigs(makeCtx());

    expect(res.success).toBe(false);
    expect(res.gigs).toEqual([]);
    expect(res.error).toMatch(/Cloudflare|stealth browser/);
  });

  it("stops early when shouldCancel flips", async () => {
    const p1 = pageBody([kleos, appercut], true);
    const { seam, calls } = makeSeam({
      direct: () => p1,
    });
    __setWantapplyFetchSeamForTests(seam);
    let checks = 0;

    const res = await findWantapplyGigs(
      makeCtx({ shouldCancel: () => ++checks > 1 }),
    );

    expect(res.success).toBe(true);
    expect(res.gigs).toHaveLength(2);
    expect(calls.direct).toBe(1);
  });

  it("caps total gigs at MAX_GIGS across multiple search terms", async () => {
    const mkJob = (term: string, page: number, i: number): WantapplyJob => ({
      id: `j-${term}-${page}-${i}`,
      title: `Role ${term}-${page}-${i}`,
      companyName: "Co",
      url: `role-${term}-${page}-${i}`,
      remote: true,
    });
    const fullPage = (term: string, page: number) =>
      pageBody(
        Array.from({ length: 20 }, (_, i) => mkJob(term, page, i)),
        true,
      );
    const { seam } = makeSeam({
      direct: (url) => {
        const term = decodeURIComponent(
          new URL(url).searchParams.get("filters") as string,
        ).replace(/.*"search":"([^"]*)".*/, "$1");
        const page = Number(new URL(url).searchParams.get("page"));
        return fullPage(term, page);
      },
    });
    __setWantapplyFetchSeamForTests(seam);

    const res = await findWantapplyGigs(
      makeCtx({ searchTerms: ["alpha", "beta", "gamma"] }),
    );

    expect(res.success).toBe(true);
    expect(res.gigs).toHaveLength(250);
  });
});

describe("applyToWantapplyGig", () => {
  const base = {
    platform: "wantapply" as const,
    gigId: "backend-developer-at-arival-bank",
    allowCaptcha: false,
    rateBudget: { maxPerHour: 1, windowMs: 1000 },
    profile: {},
  };

  it("dry-run reports skipped and never submits", async () => {
    const res = await applyToWantapplyGig({ ...base, dryRun: true });
    expect(res.mode).toBe("dry_run");
    expect(res.status).toBe("skipped");
    expect(res.error).toContain("external ATS");
  });

  it("non-dry-run refuses honestly instead of faking a submission", async () => {
    const res = await applyToWantapplyGig({ ...base, dryRun: false });
    expect(res.mode).toBe("submit");
    expect(res.status).toBe("error");
    expect(res.error).toContain(
      "https://wantapply.com/backend-developer-at-arival-bank",
    );
    expect(res.error).toContain("never fake");
  });
});

describe("exportBatchToWantapply", () => {
  it("dry-run exports the payload without POSTing", async () => {
    const res = await exportBatchToWantapply({
      platform: "wantapply",
      gigs: [{ gigId: "g1" }],
      dryRun: true,
    });
    expect(res.mode).toBe("dry_run");
    expect(res.status).toBe("exported");
    const payload = res.exportPayload as { gigCount: number };
    expect(payload.gigCount).toBe(1);
    expect(res.error).toContain("WEBHOOK_URL");
  });

  it("non-dry-run without a webhook names the missing var", async () => {
    vi.stubEnv("JOBOPS_FREELANCE_WANTAPPLY_WEBHOOK_URL", "");
    const res = await exportBatchToWantapply({
      platform: "wantapply",
      gigs: [{ gigId: "g1" }],
      dryRun: false,
    });
    expect(res.mode).toBe("submit");
    expect(res.status).toBe("error");
    expect(res.error).toContain("JOBOPS_FREELANCE_WANTAPPLY_WEBHOOK_URL");
  });
});
