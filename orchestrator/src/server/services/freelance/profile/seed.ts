/**
 * Phase-1 seed of the profile campaign state (2026-08-28).
 *
 * Encodes the phase-1 report into freelance_profiles (+ the contra works
 * into freelance_profile_content). Idempotent: re-running upserts the same
 * rows; live backends (api re-runs, operator /record reports) then layer
 * verified state on top.
 *
 * Report (phase 1, 2026-08-28):
 *   - contra: 33%, works 1-2 published, works 3-4 pending; blocked: session
 *     re-login (done by sibling agent — verify via re-read), identity
 *     verification, wallet
 *   - upwork: 100% profile complete, unpublished (DOB/street/city/phone =
 *     user_only)
 *   - malt: 90% done
 *   - wellfound: 95% (remote enabled, photo+demos user_only)
 *   - braintrust: ~40% (API fields done: headline/bio/languages/timezone;
 *     browser items pending)
 *   - freelancer.com: languages done, DOB wall (user_only)
 *   - fiverr/toptal/turing/arc-dev/pph/guru/flexjobs: 20% pre-relogin
 *     (sibling agent completing them now — marked in_progress; the operator
 *     records results via POST /api/freelance/profiles/:platform/record)
 *   - weworkremotely: not-applicable (employer ATS board, job-seeker account
 *     being created)
 */
import {
  upsertProfile,
  upsertProfileContent,
  type ProfileFieldState,
} from "./state";

type F = Record<string, Partial<ProfileFieldState>>;

interface SeedRow {
  completeness?: string;
  status: string;
  fields: F;
}

const done = (value?: string, evidence?: string) => ({
  status: "done" as const,
  ...(value ? { value } : {}),
  ...(evidence ? { evidence } : {}),
});
const pending = (evidence?: string) => ({
  status: "pending" as const,
  ...(evidence ? { evidence } : {}),
});
const blocked = (evidence: string) => ({ status: "blocked" as const, evidence });
const userOnly = (evidence?: string) => ({
  status: "user_only" as const,
  ...(evidence ? { evidence } : {}),
});

const RELOGIN_NOTE =
  "20% pre-relogin state at seed — sibling operator agent completing the re-login now; record results via POST /api/freelance/profiles/:platform/record";

const USER_ONLY_FIELDS: F = {
  dob: userOnly(),
  phone: userOnly(),
  face_photo: userOnly(),
  street_address: userOnly(),
};

export const PROFILE_SEED: Record<string, SeedRow> = {
  contra: {
    completeness: "33%",
    status: "in_progress",
    fields: {
      headline: done("Senior Full-Stack Developer (Node.js/React)"),
      bio: done(undefined, "phase 1 report: about section filled"),
      works: done("2 published, 2 pending", "phase 1 report: works 1-2 published, 3-4 pending"),
      skills: pending("session gate: re-read via the api probe first"),
      work_history: pending("session gate: re-read via the api probe first"),
      rate: pending("session gate: re-read via the api probe first"),
      location: pending("session gate: re-read via the api probe first"),
      languages: pending("session gate: re-read via the api probe first"),
      availability: pending("session gate: re-read via the api probe first"),
      social_links: pending("session gate: re-read via the api probe first"),
      education: pending("session gate: re-read via the api probe first"),
      identity_verification: blocked("user gate: KYC documents must be uploaded by the user"),
      wallet_setup: blocked("user gate: payout/bank details must be added by the user"),
      ...USER_ONLY_FIELDS,
    },
  },
  upwork: {
    completeness: "100%",
    status: "complete",
    fields: {
      headline: done(),
      bio: done(),
      skills: done(),
      work_history: done(),
      education: done(),
      rate: done("8h/day capacity; category rates set", "phase 1 report: 100% complete"),
      location: done("country + remote set (city is user_only)"),
      languages: done(),
      availability: done(),
      social_links: done(),
      portfolio: pending("portfolio items not yet added"),
      profile_visibility: pending("profile is unpublished — make it searchable (browser_mac)"),
      city: userOnly("phase 1 report: city is part of the user-only wall"),
      ...USER_ONLY_FIELDS,
    },
  },
  malt: {
    completeness: "90%",
    status: "in_progress",
    fields: {
      headline: done(),
      bio: done(),
      skills: done(),
      work_history: done(),
      education: pending("last 10% (phase 1)"),
      rate: done("685 EUR/day"),
      location: done("remote enabled"),
      languages: done(),
      availability: done(),
      social_links: done(),
      projects: pending("case studies not yet added"),
      ...USER_ONLY_FIELDS,
    },
  },
  wellfound: {
    completeness: "95%",
    status: "in_progress",
    fields: {
      headline: done("name/title set"),
      bio: done(undefined, "api verified (ProfileSaveBio + re-read)"),
      skills: done(undefined, "api verified (ProfileSaveSkills + re-read)"),
      work_history: done("xRocket current role saved via api"),
      education: pending("ProfileSaveEducation 500s server-side — browser-only"),
      rate: done("180000 EUR expected salary", "api verified (ProfileSaveExpectedSalary + re-read)"),
      location: done("REMOTE_PREFERRED", "api verified (ProfileSaveInterestedLocations + re-read)"),
      languages: done(),
      availability: done(),
      social_links: done("linkedin + github", "api verified (ProfileSaveSocialProfiles + re-read)"),
      demos: userOnly("phase 1 report: demos are user-only"),
      ...USER_ONLY_FIELDS,
    },
  },
  braintrust: {
    completeness: "40%",
    status: "in_progress",
    fields: {
      headline: done(undefined, "api PATCH /api/user/user/ + re-read (phase 1)"),
      bio: done(undefined, "api PATCH /api/user/user/ + re-read (phase 1)"),
      skills: pending("browser-only: employer-managed, user endpoint is a no-op"),
      work_history: pending("browser-only: UI save gated on automated sessions"),
      education: pending("browser-only"),
      rate: pending("no public rate field in the API — browser-only"),
      location: done("Europe/Berlin", "api PATCH /api/user/user/ + re-read (phase 1)"),
      languages: done("DE + EN (ids 14, 90)", "api PATCH /api/user/user/ + re-read (phase 1)"),
      availability: pending("browser-only: UI save gated on freelancer_approved"),
      social_links: pending("browser-only"),
      ...USER_ONLY_FIELDS,
    },
  },
  freelancer: {
    status: "blocked",
    fields: {
      headline: pending("writes need OAuth token + email verification (see profile status)"),
      bio: pending("writes need OAuth token + email verification (see profile status)"),
      skills: pending("no user-scoped skill endpoint — browser-only"),
      work_history: pending("not part of the profile API (resume-based) — browser-only"),
      education: pending("not part of the profile API (resume-based) — browser-only"),
      rate: pending("writes need OAuth token + email verification (see profile status)"),
      location: pending("writes need OAuth token + email verification (see profile status)"),
      languages: done(undefined, "phase 1 report: languages done"),
      availability: pending("writes need OAuth token + email verification (see profile status)"),
      social_links: pending("writes need OAuth token + email verification (see profile status)"),
      dob: userOnly("DOB wall: date of birth must be set by the user (privacy line)"),
      ...USER_ONLY_FIELDS,
    },
  },
  fiverr: {
    completeness: "20%",
    status: "in_progress",
    fields: {
      headline: done(undefined, RELOGIN_NOTE),
      bio: done(undefined, RELOGIN_NOTE),
      skills: pending(RELOGIN_NOTE),
      work_history: pending(RELOGIN_NOTE),
      education: pending(RELOGIN_NOTE),
      rate: pending(RELOGIN_NOTE),
      location: pending(RELOGIN_NOTE),
      languages: pending(RELOGIN_NOTE),
      availability: pending(RELOGIN_NOTE),
      social_links: pending(RELOGIN_NOTE),
      gigs: pending(RELOGIN_NOTE),
      ...USER_ONLY_FIELDS,
    },
  },
  toptal: {
    completeness: "20%",
    status: "in_progress",
    fields: {
      headline: done(undefined, RELOGIN_NOTE),
      bio: done(undefined, RELOGIN_NOTE),
      skills: pending(RELOGIN_NOTE),
      work_history: pending(RELOGIN_NOTE),
      education: pending(RELOGIN_NOTE),
      rate: pending(RELOGIN_NOTE),
      location: pending(RELOGIN_NOTE),
      languages: pending(RELOGIN_NOTE),
      availability: pending(RELOGIN_NOTE),
      social_links: pending(RELOGIN_NOTE),
      community_applications: pending(RELOGIN_NOTE),
      ...USER_ONLY_FIELDS,
    },
  },
  turing: {
    completeness: "20%",
    status: "in_progress",
    fields: {
      headline: done(undefined, RELOGIN_NOTE),
      bio: done(undefined, RELOGIN_NOTE),
      skills: pending(RELOGIN_NOTE),
      work_history: pending(RELOGIN_NOTE),
      education: pending(RELOGIN_NOTE),
      rate: pending(RELOGIN_NOTE),
      location: pending(RELOGIN_NOTE),
      languages: pending(RELOGIN_NOTE),
      availability: pending(RELOGIN_NOTE),
      social_links: pending(RELOGIN_NOTE),
      portfolio: pending(RELOGIN_NOTE),
      ...USER_ONLY_FIELDS,
    },
  },
  "arc-dev": {
    completeness: "20%",
    status: "in_progress",
    fields: {
      headline: done(undefined, RELOGIN_NOTE),
      bio: done(undefined, RELOGIN_NOTE),
      skills: pending(RELOGIN_NOTE),
      work_history: pending(RELOGIN_NOTE),
      education: pending(RELOGIN_NOTE),
      rate: pending(RELOGIN_NOTE),
      location: pending(RELOGIN_NOTE),
      languages: pending(RELOGIN_NOTE),
      availability: pending(RELOGIN_NOTE),
      social_links: pending(RELOGIN_NOTE),
      portfolio: pending(RELOGIN_NOTE),
      ...USER_ONLY_FIELDS,
    },
  },
  peopleperhour: {
    completeness: "20%",
    status: "in_progress",
    fields: {
      headline: done(undefined, RELOGIN_NOTE),
      bio: done(undefined, RELOGIN_NOTE),
      skills: pending(RELOGIN_NOTE),
      work_history: pending(RELOGIN_NOTE),
      education: pending(RELOGIN_NOTE),
      rate: pending(RELOGIN_NOTE),
      location: pending(RELOGIN_NOTE),
      languages: pending(RELOGIN_NOTE),
      availability: pending(RELOGIN_NOTE),
      social_links: pending(RELOGIN_NOTE),
      services: pending(RELOGIN_NOTE),
      ...USER_ONLY_FIELDS,
    },
  },
  guru: {
    completeness: "20%",
    status: "in_progress",
    fields: {
      headline: done(undefined, RELOGIN_NOTE),
      bio: done(undefined, RELOGIN_NOTE),
      skills: pending(RELOGIN_NOTE),
      work_history: pending(RELOGIN_NOTE),
      education: pending(RELOGIN_NOTE),
      rate: pending(RELOGIN_NOTE),
      location: pending(RELOGIN_NOTE),
      languages: pending(RELOGIN_NOTE),
      availability: pending(RELOGIN_NOTE),
      social_links: pending(RELOGIN_NOTE),
      projects: pending(RELOGIN_NOTE),
      ...USER_ONLY_FIELDS,
    },
  },
  flexjobs: {
    completeness: "20%",
    status: "in_progress",
    fields: {
      headline: done(undefined, RELOGIN_NOTE),
      bio: done(undefined, RELOGIN_NOTE),
      skills: pending(RELOGIN_NOTE),
      work_history: pending(RELOGIN_NOTE),
      education: pending(RELOGIN_NOTE),
      rate: pending(RELOGIN_NOTE),
      location: pending(RELOGIN_NOTE),
      languages: pending(RELOGIN_NOTE),
      availability: pending(RELOGIN_NOTE),
      social_links: pending(RELOGIN_NOTE),
      ...USER_ONLY_FIELDS,
    },
  },
  weworkremotely: {
    completeness: "n/a",
    status: "not-applicable",
    fields: {},
  },
};

/** Contra works from the phase-1 report: 1-2 published, 3-4 pending. */
const CONTRA_WORKS: Array<{ title: string; status: "published" | "drafted" }> = [
  { title: "Real-time Social Trading Platform (30k+ DAU)", status: "published" },
  { title: "P2P Payment Gateway ($2M+/month, 15+ methods)", status: "published" },
  { title: "WebSocket Multiplayer Game Backend (500+ concurrent)", status: "drafted" },
  { title: "FinTech Microservices Platform (Kafka, high concurrency)", status: "drafted" },
];

/**
 * Idempotently seed the phase-1 campaign state. Returns the seeded platform
 * ids. Safe to re-run: it only touches profile + content rows.
 */
export function seedProfileCampaignState(): string[] {
  for (const [platform, row] of Object.entries(PROFILE_SEED)) {
    upsertProfile(platform, {
      status: row.status,
      completeness: row.completeness,
      fields: row.fields,
    });
  }
  for (const work of CONTRA_WORKS) {
    upsertProfileContent({
      platform: "contra",
      kind: "post",
      title: work.title,
      status: work.status,
      externalRef: work.status === "published" ? "contra.com (phase 1)" : undefined,
    });
  }
  return Object.keys(PROFILE_SEED);
}
