import { createHash } from "node:crypto";
import type { CreateGigInput, FreelanceGig } from "@shared/types/freelance";

/** Normalize a string for fuzzy comparison. */
export function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(senior|junior|sr|jr|lead|staff|principal)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Strip tracking params so the same posting shares a URL identity. */
export function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|gclid|fbclid|mc_)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    let path = url.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Stable dedupe hash: canonical URL wins when present, otherwise
 * normalized title + employer. Cross-platform reposts of the same
 * gig collapse onto one hash.
 */
export function computeDedupHash(gig: CreateGigInput): string {
  const url = canonicalizeUrl(gig.gigUrl);
  const key = `${normalizeForCompare(gig.title)}|${normalizeForCompare(gig.clientOrEmployer)}`;
  return createHash("sha256")
    .update(`${url}::${key}`)
    .digest("hex")
    .slice(0, 32);
}

/** Levenshtein-lite similarity in [0,1] over token sets. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeForCompare(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeForCompare(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
}

export interface DedupeResult {
  unique: Array<CreateGigInput & { dedupHash: string }>;
  duplicatesRemoved: number;
  fuzzyMerges: number;
}

/**
 * Two-pass dedupe:
 *   1. exact dedupHash collapse (canonical URL / title+employer)
 *   2. fuzzy pass — same employer + title similarity >= threshold
 *
 * Keeps the richer record (more populated fields) when merging.
 */
export function dedupeGigs(
  gigs: CreateGigInput[],
  options: { fuzzyThreshold?: number } = {},
): DedupeResult {
  const threshold = options.fuzzyThreshold ?? 0.9;
  const byHash = new Map<string, CreateGigInput & { dedupHash: string }>();
  let duplicatesRemoved = 0;

  const richness = (gig: CreateGigInput): number =>
    Object.values(gig).filter(
      (value) => value !== undefined && value !== null && value !== "",
    ).length;

  for (const gig of gigs) {
    const dedupHash = computeDedupHash(gig);
    const existing = byHash.get(dedupHash);
    if (existing) {
      duplicatesRemoved += 1;
      if (richness(gig) > richness(existing)) {
        byHash.set(dedupHash, { ...gig, dedupHash });
      }
      continue;
    }
    byHash.set(dedupHash, { ...gig, dedupHash });
  }

  // Fuzzy pass
  const candidates = [...byHash.values()];
  const dropped = new Set<number>();
  let fuzzyMerges = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (dropped.has(j)) continue;
      const a = candidates[i];
      const b = candidates[j];
      const sameEmployer =
        normalizeForCompare(a.clientOrEmployer) ===
        normalizeForCompare(b.clientOrEmployer);
      if (!sameEmployer) continue;
      if (tokenSimilarity(a.title, b.title) >= threshold) {
        const loser = richness(a) >= richness(b) ? j : i;
        dropped.add(loser);
        fuzzyMerges += 1;
        if (loser === i) break;
      }
    }
  }

  return {
    unique: candidates.filter((_, index) => !dropped.has(index)),
    duplicatesRemoved,
    fuzzyMerges,
  };
}

/**
 * Deterministic heuristic score in [0,100] used when no LLM is configured,
 * and as a pre-filter before spending LLM tokens.
 */
export function heuristicGigScore(
  gig: CreateGigInput,
  profileSkills: string[] = [],
): number {
  let score = 40;

  const haystack = [
    gig.title,
    gig.gigDescription ?? "",
    (gig.skillsRequired ?? []).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  // Skill overlap is the strongest signal.
  const skills = profileSkills
    .map((skill) => skill.toLowerCase())
    .filter(Boolean);
  if (skills.length > 0) {
    const hits = skills.filter((skill) => haystack.includes(skill)).length;
    score += Math.min(35, Math.round((hits / skills.length) * 35) + hits * 3);
  }

  // Budget signals
  if (gig.budgetMax !== undefined && gig.budgetMax > 0) score += 8;
  if (gig.budgetInterval === "hourly") score += 3;
  if (gig.verifiedClient) score += 6;

  // Competition penalty
  if (gig.proposalCount !== undefined) {
    if (gig.proposalCount > 50) score -= 12;
    else if (gig.proposalCount > 20) score -= 6;
  }

  // Freshness
  if (gig.datePosted) {
    const ageMs = Date.now() - new Date(gig.datePosted).getTime();
    const ageDays = ageMs / 86_400_000;
    if (Number.isFinite(ageDays)) {
      if (ageDays <= 2) score += 8;
      else if (ageDays > 30) score -= 10;
    }
  }

  if (gig.isRemote) score += 4;
  if (!gig.gigDescription || gig.gigDescription.length < 80) score -= 8;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Sort scored gigs best-first, tie-broken by budget then freshness. */
export function rankGigs<
  T extends { suitabilityScore: number | null } & CreateGigInput,
>(gigs: T[]): T[] {
  return [...gigs].sort((a, b) => {
    const scoreDiff = (b.suitabilityScore ?? 0) - (a.suitabilityScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const budgetDiff = (b.budgetMax ?? 0) - (a.budgetMax ?? 0);
    if (budgetDiff !== 0) return budgetDiff;
    const aDate = a.datePosted ? Date.parse(a.datePosted) : 0;
    const bDate = b.datePosted ? Date.parse(b.datePosted) : 0;
    return bDate - aDate;
  });
}

export type { FreelanceGig };
