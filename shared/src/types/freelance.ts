// --- Freelance platform identifiers ---
export const FREELANCE_PLATFORM_IDS = [
  "upwork",
  "freelancer",
  "fiverr",
  "toptal",
  "peopleperhour",
  "guru",
  "remoteok",
  "weworkremotely",
  "malt",
  "freelancermap",
  "wellfound",
  "braintrust",
  "contra",
  "arc-dev",
  "gun-io",
  "turing",
  "flexjobs",
  "wantapply",
  "aggregator-core",
] as const;
export type FreelancePlatformId = (typeof FREELANCE_PLATFORM_IDS)[number];

// --- Gig (freelance job listing) ---
export interface CreateGigInput {
  platform: FreelancePlatformId;
  sourceGigId?: string;
  title: string;
  clientOrEmployer: string;
  gigUrl: string;
  applicationLink?: string;
  budget?: string;
  budgetMin?: number;
  budgetMax?: number;
  budgetCurrency?: string;
  budgetInterval?: "fixed" | "hourly";
  deadline?: string;
  datePosted?: string;
  gigDescription?: string;
  skillsRequired?: string[];
  jobType?: string;
  isRemote?: boolean;
  location?: string;
  duration?: string;
  proposalCount?: number;
  verifiedClient?: boolean;
}

/** A gig persisted by the aggregator (adds identity + scoring + dedupe fields). */
export interface FreelanceGig extends CreateGigInput {
  id: string;
  dedupHash: string;
  status: FreelanceGigStatus;
  suitabilityScore: number | null;
  discoveredAt: string;
  updatedAt: string;
}

export type FreelanceGigStatus =
  | "discovered"
  | "scored"
  | "ready"
  | "queued"
  | "proposed"
  | "submitted"
  | "won"
  | "lost"
  | "skipped";

// --- Proposal draft (applier output; never auto-submitted unless opted-in + tailored) ---
export interface ProposalDraft {
  platform: FreelancePlatformId;
  gigId: string;
  sourceGigId?: string;
  coverLetter: string;
  proposedRate?: string;
  proposedDuration?: string;
  milestones?: Array<{ title: string; description: string; amount?: number }>;
  tailored: boolean;
  generatedAt: string;
}

// --- Applier adapter contract ---
export type FreelanceApplyMode = "dry_run" | "draft" | "submit";

export interface FreelanceApplyResult {
  platform: FreelancePlatformId;
  mode: FreelanceApplyMode;
  status: "drafted" | "submitted" | "exported" | "skipped" | "error";
  proposalDraft?: ProposalDraft;
  externalRef?: string;
  exportPayload?: unknown;
  error?: string;
  captcha?: {
    attempted: boolean;
    solved: boolean;
    type: string | null;
    provider: string | null;
    message?: string;
  };
}

// --- Earnings tracking ---
export interface FreelanceEarning {
  id: string;
  gigId: string;
  platform: FreelancePlatformId;
  amount: number;
  currency: string;
  status: "pending" | "invoiced" | "paid" | "cancelled";
  paidAt: string | null;
  recordedAt: string;
}

// --- Provider module shape (every platform exports this) ---
export interface FreelanceProviderManifest {
  id: FreelancePlatformId;
  displayName: string;
  kind: string;
  findGigs(ctx: FreelanceFinderContext): Promise<FreelanceFinderResult>;
  applyToGig?(ctx: FreelanceApplyContext): Promise<FreelanceApplyResult>;
  exportBatch?(ctx: FreelanceExportContext): Promise<FreelanceApplyResult>;
}

export interface FreelanceFinderResult {
  success: boolean;
  gigs: CreateGigInput[];
  error?: string;
  challengeRequired?: string;
}

export interface FreelanceFinderContext {
  platform: FreelancePlatformId;
  searchTerms: string[];
  selectedCountry: string;
  settings: Record<string, string | undefined>;
  shouldCancel?: () => boolean;
  onProgress?: (event: {
    phase: "list";
    detail?: string;
    currentUrl?: string;
  }) => void;
}

export interface FreelanceApplyContext {
  platform: FreelancePlatformId;
  gigId: string;
  dryRun: boolean;
  allowCaptcha: boolean;
  rateBudget: { maxPerHour: number; windowMs: number };
  profile: unknown;
}

export interface FreelanceExportContext {
  platform: FreelancePlatformId;
  gigs: Array<{ gigId: string; sourceGigId?: string }>;
  dryRun: boolean;
  webhookUrl?: string;
}

// --- Aggregator cycle report ---
export interface FreelanceAggregatorCycleResult {
  startedAt: string;
  finishedAt: string;
  discovered: number;
  deduped: number;
  scored: number;
  enqueued: number;
  perPlatform: Array<{
    platform: FreelancePlatformId;
    success: boolean;
    found: number;
    error?: string;
  }>;
}

// --- Registry metadata ---
export const FREELANCE_PLATFORM_METADATA: Record<
  FreelancePlatformId,
  {
    label: string;
    kind: string;
    order: number;
    hasRealFinder: boolean;
    applyArtifact:
      | "proposal"
      | "bid"
      | "quote"
      | "offer"
      | "application"
      | "outreach"
      | "export";
  }
> = {
  upwork: {
    label: "Upwork",
    kind: "freelance-marketplace",
    order: 1,
    hasRealFinder: false,
    applyArtifact: "proposal",
  },
  freelancer: {
    label: "Freelancer.com",
    kind: "freelance-marketplace",
    order: 2,
    hasRealFinder: false,
    applyArtifact: "bid",
  },
  fiverr: {
    label: "Fiverr",
    kind: "gig-marketplace",
    order: 3,
    hasRealFinder: false,
    applyArtifact: "offer",
  },
  toptal: {
    label: "Toptal",
    kind: "talent-network",
    order: 4,
    hasRealFinder: false,
    applyArtifact: "application",
  },
  peopleperhour: {
    label: "PeoplePerHour",
    kind: "freelance-marketplace",
    order: 5,
    hasRealFinder: false,
    applyArtifact: "proposal",
  },
  guru: {
    label: "Guru",
    kind: "freelance-marketplace",
    order: 6,
    hasRealFinder: false,
    applyArtifact: "bid",
  },
  remoteok: {
    label: "RemoteOK",
    kind: "remote-job-board",
    order: 7,
    hasRealFinder: true,
    applyArtifact: "application",
  },
  weworkremotely: {
    label: "We Work Remotely",
    kind: "remote-job-board",
    order: 8,
    hasRealFinder: true,
    applyArtifact: "application",
  },
  malt: {
    label: "Malt",
    kind: "freelance-marketplace",
    order: 9,
    hasRealFinder: false,
    applyArtifact: "proposal",
  },
  freelancermap: {
    label: "freelancermap (DE)",
    kind: "freelance-marketplace",
    order: 10,
    hasRealFinder: false,
    applyArtifact: "quote",
  },
  wellfound: {
    label: "Wellfound (AngelList)",
    kind: "startup-job-board",
    order: 11,
    hasRealFinder: false,
    applyArtifact: "application",
  },
  braintrust: {
    label: "Braintrust",
    kind: "talent-network",
    order: 12,
    hasRealFinder: false,
    applyArtifact: "proposal",
  },
  contra: {
    label: "Contra",
    kind: "freelance-marketplace",
    order: 13,
    hasRealFinder: false,
    applyArtifact: "proposal",
  },
  "arc-dev": {
    label: "Arc.dev",
    kind: "talent-network",
    order: 14,
    hasRealFinder: false,
    applyArtifact: "application",
  },
  "gun-io": {
    label: "Gun.io",
    kind: "talent-network",
    order: 15,
    hasRealFinder: false,
    applyArtifact: "proposal",
  },
  turing: {
    label: "Turing",
    kind: "talent-network",
    order: 16,
    hasRealFinder: false,
    applyArtifact: "application",
  },
  flexjobs: {
    label: "FlexJobs",
    kind: "remote-job-board",
    order: 17,
    hasRealFinder: false,
    applyArtifact: "application",
  },
  wantapply: {
    label: "Wantapply",
    kind: "auto-apply-exporter",
    order: 18,
    hasRealFinder: false,
    applyArtifact: "export",
  },
  "aggregator-core": {
    label: "Freelance Aggregator Engine",
    kind: "aggregator",
    order: 100,
    hasRealFinder: false,
    applyArtifact: "application",
  },
};

/** Platforms that ship a working, credential-free finder today. */
export const FREELANCE_REAL_FINDER_PLATFORMS: readonly FreelancePlatformId[] =
  FREELANCE_PLATFORM_IDS.filter(
    (id) => FREELANCE_PLATFORM_METADATA[id].hasRealFinder,
  );
