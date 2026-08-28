/**
 * Profile-campaign platform registry (docs/freelance-profile-campaign.md).
 *
 * One spec per campaign platform: profile URL, execution backend, the field
 * list (with read/write method notes) and the post / publish / promote action
 * definitions derived from the live platform playbooks.
 *
 * Backends:
 *   - api             direct HTTP with the session cookie — runs the
 *                     orchestrator/scripts/profile-fill/<platform>.ts scripts
 *                     (idempotent: read, diff, write, re-read + verify).
 *   - browser_sandbox Playwright + cookies inside the sandbox for platforms
 *                     that are NOT IP-blocked from the datacenter.
 *   - browser_mac     step list persisted as `pending` rows in
 *                     freelance_profile_actions; the Mac operator agent
 *                     applies them and POSTs results back via
 *                     /api/freelance/profiles/:platform/record.
 *   - none            not applicable (e.g. employer-side ATS board).
 *
 * Privacy lines (NEVER autofilled): dob, phone, face_photo, street_address —
 * always seeded with status `user_only`.
 */

export type ProfileBackend = "api" | "browser_sandbox" | "browser_mac" | "none";

/** Fields that are never autofilled — the user must fill them personally. */
export const USER_ONLY_FIELDS = [
  "dob",
  "phone",
  "face_photo",
  "street_address",
] as const;

export interface ProfileFieldSpec {
  /** Field key, e.g. "headline", "dob". */
  name: string;
  label: string;
  /** How the backend reads/writes it: API path, UI selector or n/a. */
  method: string;
  userOnly?: boolean;
}

export interface ProfileActionDef {
  kind: "post" | "publish" | "promote";
  description: string;
  /** What gets created: gig | post | portfolio_item | community_apply |
   *  profile_publish | availability. */
  artifact:
    | "gig"
    | "post"
    | "portfolio_item"
    | "community_apply"
    | "profile_publish"
    | "availability";
  applicable: boolean;
  /** Why it is not applicable (when applicable=false). */
  reason?: string;
  /** Operator steps for the browser_mac / browser_sandbox backends. */
  steps: string[];
}

export interface ProfilePlatformSpec {
  id: string;
  name: string;
  /** Identity slug URL when known; platform profile base otherwise. */
  profileUrl: string;
  backend: ProfileBackend;
  /** Credential file under data/.credentials (operator-managed). */
  credentialFile?: string;
  /**
   * api backend: repo-relative path of the idempotent fill/probe script.
   * `probe` scripts verify the session only and never write.
   */
  apiScript?: string;
  apiScriptKind?: "fill" | "probe";
  /** Field status covered by the api script's verified result. */
  apiCoversFields?: string[];
  fields: ProfileFieldSpec[];
  actions: {
    post?: ProfileActionDef;
    publish?: ProfileActionDef;
    promote?: ProfileActionDef;
  };
  notes?: string[];
}

// --- Shared field list -------------------------------------------------------

function userOnlyField(name: string, label: string): ProfileFieldSpec {
  return { name, label, method: "user_only (never autofilled)", userOnly: true };
}

/**
 * The standard campaign field set. `method` documents the read/write path for
 * the platform's primary backend (API path or UI area).
 */
function standardFields(
  methods: {
    headline?: string;
    bio?: string;
    skills?: string;
    workHistory?: string;
    education?: string;
    rate?: string;
    location?: string;
  } = {},
): ProfileFieldSpec[] {
  return [
    { name: "headline", label: "Headline / title", method: methods.headline ?? "UI" },
    { name: "bio", label: "Bio / about", method: methods.bio ?? "UI" },
    { name: "skills", label: "Skills", method: methods.skills ?? "UI" },
    {
      name: "work_history",
      label: "Work history / experience",
      method: methods.workHistory ?? "UI",
    },
    { name: "education", label: "Education", method: methods.education ?? "UI" },
    { name: "rate", label: "Rate / expected salary", method: methods.rate ?? "UI" },
    {
      name: "location",
      label: "Location / timezone / remote",
      method: methods.location ?? "UI",
    },
    { name: "languages", label: "Languages (DE native, EN)", method: "UI" },
    { name: "availability", label: "Availability (immediate)", method: "UI" },
    { name: "social_links", label: "LinkedIn / GitHub", method: "UI" },
    userOnlyField("dob", "Date of birth"),
    userOnlyField("phone", "Phone number"),
    userOnlyField("face_photo", "Face photo"),
    userOnlyField("street_address", "Street address"),
  ];
}

const NA_ACTION = (kind: "post" | "publish" | "promote", reason: string): ProfileActionDef => ({
  kind,
  description: reason,
  artifact: "post",
  applicable: false,
  reason,
  steps: [],
});

// --- The 14 campaign platforms ----------------------------------------------

export const PROFILE_PLATFORMS: readonly ProfilePlatformSpec[] = [
  {
    id: "upwork",
    name: "Upwork",
    profileUrl: "https://www.upwork.com/freelancers/",
    backend: "browser_mac",
    credentialFile: "upwork",
    fields: [
      ...standardFields({
        headline: "UI: profile edit",
        bio: "UI: profile edit",
        rate: "UI: rates by category",
        location: "UI: location (country/city)",
      }),
      {
        name: "profile_visibility",
        label: "Profile published (visible/searchable)",
        method: "UI: Settings > Profile visibility",
      },
      { name: "portfolio", label: "Portfolio items", method: "UI: portfolio" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Upload portfolio items (2-4 projects with media)",
        artifact: "portfolio_item",
        applicable: true,
        steps: [
          "Open profile > Portfolio, add project items from the CV portfolio (screenshots + 2-3 sentence outcomes)",
          "Tag each item with matching skills (Node.js/TypeScript, React, PostgreSQL, Docker)",
        ],
      },
      publish: {
        kind: "publish",
        description: "Publish the (currently unpublished) profile so it is searchable",
        artifact: "profile_publish",
        applicable: true,
        steps: [
          "Settings > Profile visibility: make the profile public/searchable",
          "Verify the public profile URL loads and shows headline, bio, rates, location, portfolio",
        ],
      },
      promote: {
        kind: "promote",
        description: "Set immediate availability and review profile boost options",
        artifact: "availability",
        applicable: true,
        steps: [
          "Confirm 'Available now' status and the 8h/day / 40h per week capacity",
          "Check profile views/invites; enable notifications for relevant invites",
        ],
      },
    },
    notes: [
      "100% of editable fields complete (phase 1). DOB/street/city/phone are user_only.",
      "Datacenter IPs are challenged by Upwork — all remaining work goes through the Mac operator.",
    ],
  },
  {
    id: "freelancer",
    name: "Freelancer.com",
    profileUrl: "https://www.freelancer.com/users/nikitan0xeid",
    backend: "api",
    credentialFile: "freelancer",
    apiScript: "orchestrator/scripts/profile-fill/freelancer.ts",
    apiScriptKind: "fill",
    apiCoversFields: ["headline", "bio", "rate", "location"],
    fields: [
      ...standardFields({
        headline: "API: PUT /users/0.1/self (tagline)",
        bio: "API: PUT /users/0.1/self (profile_description)",
        rate: "API: PUT /users/0.1/self (hourly_rate)",
        location: "API: PUT /users/0.1/self (address.city)",
      }),
    ],
    actions: {
      post: NA_ACTION(
        "post",
        "bid-based marketplace — project bids are the apply flow, not profile content",
      ),
      publish: NA_ACTION(
        "publish",
        "no draft/publish model — the profile is public as soon as fields are set",
      ),
      promote: {
        kind: "promote",
        description: "Promote profile / premium visibility",
        artifact: "availability",
        applicable: true,
        steps: [
          "Check Freelancer Plus / profile promotion options and enable if cost-effective",
          "Confirm the profile passes the 'profile completeness' checklist",
        ],
      },
    },
    notes: [
      "Writes need the Freelancer-OAuth-V1 token (user-generated at /api) — until then the script reports writes_skipped: needs_oauth_token.",
      "Account wall: email verification must be clicked by the user first (user_only gate).",
      "Languages were already completed in phase 1.",
    ],
  },
  {
    id: "fiverr",
    name: "Fiverr",
    profileUrl: "https://www.fiverr.com/my-profile",
    backend: "browser_mac",
    credentialFile: "fiverr",
    fields: [
      ...standardFields(),
      { name: "gigs", label: "Gigs (3-5 services)", method: "UI: Fiverr Gig Manager" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Create 3-5 gigs (Node.js backend, React frontend, full-stack, real-time systems, AI integration)",
        artifact: "gig",
        applicable: true,
        steps: [
          "Gig Manager > Create a New Gig per service (title, 3 pricing tiers, FAQ, requirements)",
          "Rate anchor: ~60 USD/hr equivalent per tier; package names Basic/Standard/Premium",
          "Add relevant tags/skills to each gig (Node.js, TypeScript, React, PostgreSQL, Docker)",
        ],
      },
      publish: {
        kind: "publish",
        description: "Publish the drafted gigs (make them live)",
        artifact: "profile_publish",
        applicable: true,
        steps: [
          "Gig Manager: review each draft, hit Publish on each gig",
          "Verify each gig URL is public and shows the pricing tiers",
        ],
      },
      promote: {
        kind: "promote",
        description: "Gig promotion / featured placement (paid boost, optional)",
        artifact: "availability",
        applicable: true,
        steps: [
          "Check Fiverr's gig promotion (paid) — enable only if budgeted",
          "Ensure profile 'Available for work' and response time settings are on",
        ],
      },
    },
    notes: [
      "20% pre-relogin state — the operator re-login was in progress at seed time; record results via POST /record.",
    ],
  },
  {
    id: "toptal",
    name: "Toptal",
    profileUrl: "https://www.toptal.com/profiles/",
    backend: "browser_mac",
    credentialFile: "toptal",
    fields: [
      ...standardFields(),
      {
        name: "community_applications",
        label: "Community / network applications",
        method: "UI: Toptal communities",
      },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Upload portfolio projects + apply to relevant Toptal communities",
        artifact: "portfolio_item",
        applicable: true,
        steps: [
          "Profile: add 2-3 portfolio projects with media and stack details",
          "Communities: apply to 2-3 communities matching backend/full-stack",
        ],
      },
      publish: NA_ACTION(
        "publish",
        "Toptal profiles are internal until network approval — nothing to publish",
      ),
      promote: {
        kind: "promote",
        description: "Keep availability current and follow up on network application",
        artifact: "community_apply",
        applicable: true,
        steps: [
          "Confirm 'available' status and desired rate (~60 USD/hr equivalent)",
          "Follow up on the talent-network application status",
        ],
      },
    },
    notes: [
      "20% pre-relogin state — the operator re-login was in progress at seed time; record results via POST /record.",
    ],
  },
  {
    id: "turing",
    name: "Turing",
    profileUrl: "https://www.turing.com/profile",
    backend: "browser_mac",
    credentialFile: "turing",
    fields: [
      ...standardFields(),
      { name: "portfolio", label: "Portfolio / projects", method: "UI: projects" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Add 2-3 portfolio projects (link repos, describe impact)",
        artifact: "portfolio_item",
        applicable: true,
        steps: [
          "Projects: add the social-trading platform, P2P payment gateway and game backend with metrics",
          "Link GitHub repos where public",
        ],
      },
      publish: NA_ACTION("publish", "no draft/publish model on Turing"),
      promote: {
        kind: "promote",
        description: "Set immediate availability + rate, stay visible to matchmakers",
        artifact: "availability",
        applicable: true,
        steps: [
          "Set availability to immediate and rate to the 685 EUR/day anchor (~60 USD/hr)",
          "Confirm timezone Europe/Berlin and remote (Germany) settings",
        ],
      },
    },
    notes: [
      "20% pre-relogin state — the operator re-login was in progress at seed time; record results via POST /record.",
    ],
  },
  {
    id: "arc-dev",
    name: "Arc.dev",
    profileUrl: "https://arc.dev/profile",
    backend: "browser_mac",
    credentialFile: "arc-dev",
    fields: [
      ...standardFields(),
      { name: "portfolio", label: "Portfolio", method: "UI: profile portfolio" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Add portfolio projects to the Arc profile",
        artifact: "portfolio_item",
        applicable: true,
        steps: [
          "Profile > Portfolio: add 2-3 projects with screenshots and outcomes",
        ],
      },
      publish: NA_ACTION("publish", "no draft/publish model on Arc.dev"),
      promote: {
        kind: "promote",
        description: "Set availability + rate for client matching",
        artifact: "availability",
        applicable: true,
        steps: [
          "Set availability to immediate, rate to the 685 EUR/day anchor",
          "Confirm skills list covers Node.js/TypeScript, React, PostgreSQL, Docker",
        ],
      },
    },
    notes: [
      "20% pre-relogin state — the operator re-login was in progress at seed time; record results via POST /record.",
    ],
  },
  {
    id: "peopleperhour",
    name: "PeoplePerHour",
    profileUrl: "https://www.peopleperhour.com/myaccount/profile/",
    backend: "browser_mac",
    credentialFile: "pph",
    fields: [
      ...standardFields(),
      { name: "services", label: "Services", method: "UI: Services (Create a service)" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Create 3 services (backend API, frontend React, full-stack)",
        artifact: "post",
        applicable: true,
        steps: [
          "Services > Create a service per offer (title, description, 3 price points)",
          "Rate anchor: 85 EUR/h base; price points per service tier",
        ],
      },
      publish: {
        kind: "publish",
        description: "Publish the drafted services",
        artifact: "profile_publish",
        applicable: true,
        steps: [
          "Services: publish each draft; verify the public service pages",
        ],
      },
      promote: {
        kind: "promote",
        description: "Profile visibility: complete the trust signals + availability",
        artifact: "availability",
        applicable: true,
        steps: [
          "Confirm availability, hourly rate and response-time badge",
          "Complete any remaining trust signals (video intro optional — user_only if it requires a face photo)",
        ],
      },
    },
    notes: [
      "20% pre-relogin state — the operator re-login was in progress at seed time; record results via POST /record.",
    ],
  },
  {
    id: "guru",
    name: "Guru",
    profileUrl: "https://www.guru.com/profile/ProfileView.aspx",
    backend: "browser_mac",
    credentialFile: "guru",
    fields: [
      ...standardFields(),
      { name: "projects", label: "Projects / portfolio", method: "UI: My Projects" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Add 2-3 showcase projects",
        artifact: "portfolio_item",
        applicable: true,
        steps: [
          "My Projects: add project pages with screenshots, stack, outcomes",
        ],
      },
      publish: NA_ACTION("publish", "no draft/publish model on Guru"),
      promote: {
        kind: "promote",
        description: "Promote profile (Guru offers paid profile promotion)",
        artifact: "availability",
        applicable: true,
        steps: [
          "Confirm hourly rate (85 EUR/h) and availability",
          "Review the paid 'Promote Profile' option — enable only if budgeted",
        ],
      },
    },
    notes: [
      "20% pre-relogin state — the operator re-login was in progress at seed time; record results via POST /record.",
    ],
  },
  {
    id: "flexjobs",
    name: "FlexJobs",
    profileUrl: "https://www.flexjobs.com/profile",
    backend: "browser_mac",
    credentialFile: "flexjobs",
    fields: standardFields(),
    actions: {
      post: {
        kind: "post",
        description: "Upload the resume + attach the portfolio",
        artifact: "portfolio_item",
        applicable: true,
        steps: [
          "Profile > Resume: upload the current CV (the job-ops generated PDF)",
          "Attach portfolio links (GitHub, selected projects)",
        ],
      },
      publish: NA_ACTION("publish", "no draft/publish model on FlexJobs"),
      promote: {
        kind: "promote",
        description: "Set availability + desired remote locations (Germany, EU, global)",
        artifact: "availability",
        applicable: true,
        steps: [
          "Set desired location: remote from Germany; timezone Europe/Berlin",
          "Confirm desired rate matches the 685 EUR/day anchor",
        ],
      },
    },
    notes: [
      "20% pre-relogin state — the operator re-login was in progress at seed time; record results via POST /record.",
    ],
  },
  {
    id: "malt",
    name: "Malt",
    profileUrl: "https://www.malt.com/profile/",
    backend: "browser_sandbox",
    credentialFile: "malt",
    fields: [
      ...standardFields({
        headline: "UI: title",
        bio: "UI: pitch",
        rate: "UI: day rate",
        location: "UI: locations (remote enabled)",
      }),
      { name: "projects", label: "Projects / case studies", method: "UI: Projects" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Add project / case-study entries",
        artifact: "portfolio_item",
        applicable: true,
        steps: [
          "Projects: add 2-3 case studies (role, stack, impact) with screenshots",
        ],
      },
      publish: {
        kind: "publish",
        description: "Publish drafted projects (make them visible to clients)",
        artifact: "profile_publish",
        applicable: true,
        steps: [
          "Projects: publish each draft; verify the public profile shows them",
        ],
      },
      promote: {
        kind: "promote",
        description: "Set availability (disponible immédiatement) + day rate",
        artifact: "availability",
        applicable: true,
        steps: [
          "Availability: set to immediate with the 685 EUR/day rate",
          "Confirm remote preference is enabled",
        ],
      },
    },
    notes: [
      "90% done in phase 1. Malt cookie works from the sandbox for discovery (CDP), so the remaining 10% + post/publish/promote go through browser_sandbox (Playwright + cookie).",
    ],
  },
  {
    id: "wellfound",
    name: "Wellfound (AngelList)",
    profileUrl: "https://wellfound.com/candidate/21663197",
    backend: "api",
    credentialFile: "wellfound",
    apiScript: "orchestrator/scripts/profile-fill/wellfound.ts",
    apiScriptKind: "fill",
    apiCoversFields: ["bio", "skills", "social_links", "rate", "location"],
    fields: [
      ...standardFields({
        bio: "GraphQL: ProfileSaveBio",
        skills: "GraphQL: ProfileSaveSkills",
        rate: "GraphQL: ProfileSaveExpectedSalary",
        location: "GraphQL: ProfileSaveInterestedLocations (remote)",
      }),
      { name: "demos", label: "Demos / media", method: "user_only (never autofilled)", userOnly: true },
    ],
    actions: {
      post: NA_ACTION("post", "job board — no self-posted content; applications are the apply flow"),
      publish: NA_ACTION(
        "publish",
        "candidate profile is public once completeness steps pass — no draft model",
      ),
      promote: NA_ACTION("promote", "no self-promotion levers on Wellfound candidate profiles"),
    },
    notes: [
      "95% in phase 1: remote enabled, bio/skills/links/salary verified via the API.",
      "Cloudflare TLS-fingerprints datacenter egress — the API script reports blocked_by_cf from the sandbox; run it from a residential connection for live re-verification.",
      "Education save 500s server-side for this account (browser-only).",
      "Photo + demos are user_only.",
    ],
  },
  {
    id: "braintrust",
    name: "Braintrust",
    profileUrl: "https://app.usebraintrust.com/profile/",
    backend: "api",
    credentialFile: "braintrust",
    apiScript: "orchestrator/scripts/profile-fill/braintrust.ts",
    apiScriptKind: "fill",
    apiCoversFields: ["headline", "bio", "languages", "location"],
    fields: [
      ...standardFields({
        headline: "API: PATCH /api/user/user/ (introduction_headline)",
        bio: "API: PATCH /api/user/user/ (introduction)",
        skills: "browser-only (employer-managed; user endpoint is a no-op)",
        rate: "no public rate field in the API — browser-only",
        location: "API: PATCH /api/user/user/ (timezone)",
      }),
    ],
    actions: {
      post: NA_ACTION("post", "talent network — no self-posted content"),
      publish: NA_ACTION("publish", "no draft/publish model; the profile page is live"),
      promote: {
        kind: "promote",
        description: "Set availability + work history (API-gated: freelancer_approved + webdriver detection)",
        artifact: "availability",
        applicable: true,
        steps: [
          "Profile > Availability: set to active/immediate",
          "Complete the work-history entries in the UI (API save is gated on automated sessions)",
        ],
      },
    },
    notes: [
      "~40%: API fields done in phase 1 (headline/bio/languages/timezone verified via re-read).",
      "Skills, work history, availability and rate are browser-only (documented API limits).",
    ],
  },
  {
    id: "contra",
    name: "Contra",
    profileUrl: "https://contra.com/u/nmime",
    backend: "browser_mac",
    credentialFile: "contra",
    apiScript: "orchestrator/scripts/profile-fill/contra.ts",
    apiScriptKind: "probe",
    fields: [
      ...standardFields({
        headline: "UI: profile edit (headline)",
        bio: "UI: profile edit (about)",
        rate: "UI: profile edit (rate)",
      }),
      { name: "works", label: "Works (3-5 items)", method: "UI: Works" },
      {
        name: "identity_verification",
        label: "Identity verification (KYC)",
        method: "user gate — document upload",
      },
      { name: "wallet_setup", label: "Wallet / payout setup", method: "user gate — bank details" },
    ],
    actions: {
      post: {
        kind: "post",
        description: "Publish works 3-4 (currently pending) + 2 more portfolio works",
        artifact: "post",
        applicable: true,
        steps: [
          "Works: create work items for the remaining portfolio projects (title, description, media, tags)",
          "Works 3-4 are already drafted — review and publish",
        ],
      },
      publish: {
        kind: "publish",
        description: "Publish the pending works so they are public",
        artifact: "profile_publish",
        applicable: true,
        steps: [
          "Works: publish each pending/drafted work; verify each public work URL",
        ],
      },
      promote: {
        kind: "promote",
        description: "Set availability + complete identity verification and wallet (revenue-gating)",
        artifact: "availability",
        applicable: true,
        steps: [
          "Settings > Identity verification: complete KYC (user documents)",
          "Settings > Wallet: add payout method (user bank details)",
          "Profile: set availability to available, rate to the 685 EUR/day anchor",
        ],
      },
    },
    notes: [
      "33% at seed time: works 1-2 published, works 3-4 pending.",
      "Session re-login was completed by the sibling operator agent — re-read via the api probe (complete) to confirm before browser writes.",
      "Identity verification + wallet are user gates (documents / bank details).",
    ],
  },
  {
    id: "weworkremotely",
    name: "We Work Remotely",
    profileUrl: "https://weworkremotely.com/",
    backend: "none",
    fields: [],
    actions: {},
    notes: [
      "not-applicable: WWR is an employer-side ATS job board — there is no freelancer profile to complete. A job-seeker account is being created for the application flow instead.",
    ],
  },
] as const;

export const PROFILE_PLATFORM_IDS: readonly string[] = PROFILE_PLATFORMS.map(
  (p) => p.id,
);

export function getProfilePlatform(id: string): ProfilePlatformSpec | undefined {
  return PROFILE_PLATFORMS.find((p) => p.id === id);
}

export function isProfilePlatform(id: string): boolean {
  return PROFILE_PLATFORM_IDS.includes(id);
}

/** The user-only fields for a platform (standard four, always). */
export function userOnlyFieldsFor(platform: ProfilePlatformSpec): string[] {
  return USER_ONLY_FIELDS.map(String);
}

/** All field names of a platform, in registry order. */
export function fieldNamesFor(platform: ProfilePlatformSpec): string[] {
  return platform.fields.map((f) => f.name);
}
