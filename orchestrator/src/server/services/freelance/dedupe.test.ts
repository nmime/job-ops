import type { CreateGigInput } from "@shared/types/freelance";
import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  computeDedupHash,
  dedupeGigs,
  heuristicGigScore,
  normalizeForCompare,
  rankGigs,
  tokenSimilarity,
} from "./dedupe";

const gig = (overrides: Partial<CreateGigInput> = {}): CreateGigInput => ({
  platform: "remoteok",
  title: "Senior TypeScript Engineer",
  clientOrEmployer: "Acme Corp",
  gigUrl: "https://example.com/jobs/1",
  ...overrides,
});

describe("canonicalizeUrl", () => {
  it("strips tracking params, trailing slash, hash and www", () => {
    expect(
      canonicalizeUrl("https://www.example.com/jobs/1/?utm_source=x&ref=y#top"),
    ).toBe("example.com/jobs/1");
  });

  it("keeps meaningful query params", () => {
    expect(canonicalizeUrl("https://example.com/j?id=42")).toBe(
      "example.com/j?id=42",
    );
  });

  it("falls back to lowercased text for invalid urls", () => {
    expect(canonicalizeUrl("Not A URL")).toBe("not a url");
  });
});

describe("normalizeForCompare", () => {
  it("drops seniority noise and punctuation", () => {
    expect(normalizeForCompare("Senior  Front-End Developer!")).toBe(
      "front end developer",
    );
  });
});

describe("computeDedupHash", () => {
  it("is stable for the same gig", () => {
    expect(computeDedupHash(gig())).toBe(computeDedupHash(gig()));
  });

  it("collapses tracking-param variants of one URL", () => {
    expect(
      computeDedupHash(gig({ gigUrl: "https://example.com/jobs/1?utm_source=a" })),
    ).toBe(computeDedupHash(gig({ gigUrl: "https://www.example.com/jobs/1/" })));
  });

  it("separates genuinely different postings", () => {
    expect(computeDedupHash(gig())).not.toBe(
      computeDedupHash(gig({ gigUrl: "https://example.com/jobs/2" })),
    );
  });
});

describe("tokenSimilarity", () => {
  it("scores identical normalized titles as 1", () => {
    expect(tokenSimilarity("Senior React Dev", "React Dev")).toBe(1);
  });

  it("scores unrelated titles low", () => {
    expect(tokenSimilarity("React Developer", "Plumbing Contractor")).toBe(0);
  });
});

describe("dedupeGigs", () => {
  it("removes exact duplicates across platforms", () => {
    const result = dedupeGigs([
      gig(),
      gig({ platform: "weworkremotely" }),
      gig({ gigUrl: "https://example.com/jobs/2", title: "Rust Systems Engineer" }),
    ]);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it("keeps the richer record when merging", () => {
    const result = dedupeGigs([
      gig(),
      gig({ gigDescription: "Long description", budgetMax: 9000 }),
    ]);
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0].budgetMax).toBe(9000);
  });

  it("fuzzy-merges near-identical titles at the same employer", () => {
    const result = dedupeGigs([
      gig({ title: "Senior TypeScript Engineer", gigUrl: "https://a.com/1" }),
      gig({ title: "TypeScript Engineer", gigUrl: "https://b.com/2" }),
    ]);
    expect(result.unique).toHaveLength(1);
    expect(result.fuzzyMerges).toBe(1);
  });

  it("does NOT merge same title at different employers", () => {
    const result = dedupeGigs([
      gig({ gigUrl: "https://a.com/1" }),
      gig({ clientOrEmployer: "Other Inc", gigUrl: "https://b.com/2" }),
    ]);
    expect(result.unique).toHaveLength(2);
  });

  it("handles an empty input", () => {
    expect(dedupeGigs([]).unique).toEqual([]);
  });
});

describe("heuristicGigScore", () => {
  it("stays within 0..100", () => {
    expect(heuristicGigScore(gig())).toBeGreaterThanOrEqual(0);
    expect(heuristicGigScore(gig())).toBeLessThanOrEqual(100);
  });

  it("rewards skill overlap", () => {
    const withSkills = heuristicGigScore(
      gig({ gigDescription: "We need TypeScript and React experience here." }),
      ["typescript", "react"],
    );
    const without = heuristicGigScore(
      gig({ gigDescription: "We need TypeScript and React experience here." }),
      [],
    );
    expect(withSkills).toBeGreaterThan(without);
  });

  it("penalizes crowded gigs", () => {
    const crowded = heuristicGigScore(gig({ proposalCount: 80 }));
    const quiet = heuristicGigScore(gig({ proposalCount: 2 }));
    expect(crowded).toBeLessThan(quiet);
  });

  it("rewards a verified client and a budget ceiling", () => {
    expect(
      heuristicGigScore(gig({ verifiedClient: true, budgetMax: 5000 })),
    ).toBeGreaterThan(heuristicGigScore(gig()));
  });

  it("penalizes stale postings", () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    expect(heuristicGigScore(gig({ datePosted: old }))).toBeLessThan(
      heuristicGigScore(gig({ datePosted: fresh })),
    );
  });
});

describe("rankGigs", () => {
  it("orders by score, then budget, then recency", () => {
    const ranked = rankGigs([
      { ...gig({ gigUrl: "https://a.com/1" }), suitabilityScore: 50 },
      { ...gig({ gigUrl: "https://a.com/2" }), suitabilityScore: 90 },
      { ...gig({ gigUrl: "https://a.com/3" }), suitabilityScore: 70 },
    ]);
    expect(ranked.map((g) => g.suitabilityScore)).toEqual([90, 70, 50]);
  });

  it("breaks score ties with the higher budget", () => {
    const ranked = rankGigs([
      { ...gig({ gigUrl: "https://a.com/1", budgetMax: 100 }), suitabilityScore: 80 },
      { ...gig({ gigUrl: "https://a.com/2", budgetMax: 900 }), suitabilityScore: 80 },
    ]);
    expect(ranked[0].budgetMax).toBe(900);
  });
});
