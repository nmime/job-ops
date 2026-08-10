import { randomUUID } from "node:crypto";
import type {
  CreateGigInput,
  FreelanceGigStatus,
  FreelancePlatformId,
} from "@shared/types/freelance";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { getActiveTenantId } from "../tenancy/context";

const { freelanceGigs, freelanceProposals, freelanceEarnings } = schema;

// ---------------------------------------------------------------------------
// Gigs
// ---------------------------------------------------------------------------

export type GigRow = typeof freelanceGigs.$inferSelect;

export async function upsertGig(
  input: CreateGigInput & {
    dedupHash: string;
    suitabilityScore?: number | null;
  },
): Promise<{ gig: GigRow; created: boolean }> {
  const tenantId = getActiveTenantId();
  const existing = db
    .select()
    .from(freelanceGigs)
    .where(
      and(
        eq(freelanceGigs.tenantId, tenantId),
        eq(freelanceGigs.dedupHash, input.dedupHash),
      ),
    )
    .limit(1)
    .all();

  const now = new Date().toISOString();

  if (existing[0]) {
    // Refresh mutable fields but keep status if it has progressed.
    db.update(freelanceGigs)
      .set({
        title: input.title,
        clientOrEmployer: input.clientOrEmployer,
        budget: input.budget ?? existing[0].budget,
        suitabilityScore:
          input.suitabilityScore ?? existing[0].suitabilityScore,
        updatedAt: now,
      })
      .where(eq(freelanceGigs.id, existing[0].id))
      .run();
    return {
      gig: { ...existing[0], updatedAt: now },
      created: false,
    };
  }

  const id = randomUUID();
  const row: typeof freelanceGigs.$inferInsert = {
    id,
    tenantId,
    platform: input.platform,
    sourceGigId: input.sourceGigId ?? null,
    title: input.title,
    clientOrEmployer: input.clientOrEmployer,
    gigUrl: input.gigUrl,
    applicationLink: input.applicationLink ?? null,
    budget: input.budget ?? null,
    budgetMin: input.budgetMin ?? null,
    budgetMax: input.budgetMax ?? null,
    budgetCurrency: input.budgetCurrency ?? null,
    budgetInterval: input.budgetInterval ?? null,
    deadline: input.deadline ?? null,
    datePosted: input.datePosted ?? null,
    gigDescription: input.gigDescription ?? null,
    skillsRequired: input.skillsRequired
      ? JSON.stringify(input.skillsRequired)
      : null,
    jobType: input.jobType ?? null,
    isRemote: input.isRemote ?? null,
    location: input.location ?? null,
    duration: input.duration ?? null,
    proposalCount: input.proposalCount ?? null,
    verifiedClient: input.verifiedClient ?? null,
    dedupHash: input.dedupHash,
    status: "discovered",
    suitabilityScore: input.suitabilityScore ?? null,
    discoveredAt: now,
    updatedAt: now,
  };
  db.insert(freelanceGigs).values(row).run();
  return {
    gig: db
      .select()
      .from(freelanceGigs)
      .where(eq(freelanceGigs.id, id))
      .get() as GigRow,
    created: true,
  };
}

export async function listGigs(
  options: {
    status?: FreelanceGigStatus;
    platform?: FreelancePlatformId;
    minScore?: number;
    limit?: number;
  } = {},
): Promise<GigRow[]> {
  const tenantId = getActiveTenantId();
  const conditions = [eq(freelanceGigs.tenantId, tenantId)];
  if (options.status) conditions.push(eq(freelanceGigs.status, options.status));
  if (options.platform)
    conditions.push(eq(freelanceGigs.platform, options.platform));
  if (options.minScore != null)
    conditions.push(gte(freelanceGigs.suitabilityScore, options.minScore));

  return db
    .select()
    .from(freelanceGigs)
    .where(and(...conditions))
    .orderBy(
      sql`COALESCE(${freelanceGigs.suitabilityScore}, 0) DESC`,
      desc(freelanceGigs.updatedAt),
    )
    .limit(options.limit ?? 200)
    .all();
}

export async function updateGigStatus(
  id: string,
  status: FreelanceGigStatus,
): Promise<void> {
  db.update(freelanceGigs)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(freelanceGigs.id, id))
    .run();
}

export async function countGigsByStatus(): Promise<Record<string, number>> {
  const tenantId = getActiveTenantId();
  const rows = db
    .select({
      status: freelanceGigs.status,
      count: sql<number>`count(*)`,
    })
    .from(freelanceGigs)
    .where(eq(freelanceGigs.tenantId, tenantId))
    .groupBy(freelanceGigs.status)
    .all();
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalRow = typeof freelanceProposals.$inferSelect;

export async function saveProposal(input: {
  gigId: string;
  platform: FreelancePlatformId;
  sourceGigId?: string;
  coverLetter: string;
  proposedRate?: string;
  proposedDuration?: string;
  tailored: boolean;
  mode: "dry_run" | "draft" | "submit";
  status: "drafted" | "submitted" | "exported" | "skipped" | "error";
  externalRef?: string;
  error?: string;
}): Promise<ProposalRow> {
  const tenantId = getActiveTenantId();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(freelanceProposals)
    .values({
      id,
      tenantId,
      gigId: input.gigId,
      platform: input.platform,
      sourceGigId: input.sourceGigId ?? null,
      coverLetter: input.coverLetter,
      proposedRate: input.proposedRate ?? null,
      proposedDuration: input.proposedDuration ?? null,
      tailored: input.tailored,
      mode: input.mode,
      status: input.status,
      externalRef: input.externalRef ?? null,
      error: input.error ?? null,
      generatedAt: now,
      submittedAt: input.status === "submitted" ? now : null,
    })
    .run();
  return db
    .select()
    .from(freelanceProposals)
    .where(eq(freelanceProposals.id, id))
    .get() as ProposalRow;
}

export async function listProposals(limit = 100): Promise<ProposalRow[]> {
  const tenantId = getActiveTenantId();
  return db
    .select()
    .from(freelanceProposals)
    .where(eq(freelanceProposals.tenantId, tenantId))
    .orderBy(desc(freelanceProposals.generatedAt))
    .limit(limit)
    .all();
}

export async function countProposalsByStatus(): Promise<
  Record<string, number>
> {
  const tenantId = getActiveTenantId();
  const rows = db
    .select({
      status: freelanceProposals.status,
      count: sql<number>`count(*)`,
    })
    .from(freelanceProposals)
    .where(eq(freelanceProposals.tenantId, tenantId))
    .groupBy(freelanceProposals.status)
    .all();
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

export type EarningRow = typeof freelanceEarnings.$inferSelect;

export async function recordEarning(input: {
  gigId?: string;
  platform: FreelancePlatformId;
  amount: number;
  currency?: string;
  status?: "pending" | "invoiced" | "paid" | "cancelled";
}): Promise<EarningRow> {
  const tenantId = getActiveTenantId();
  const id = randomUUID();
  db.insert(freelanceEarnings)
    .values({
      id,
      tenantId,
      gigId: input.gigId ?? null,
      platform: input.platform,
      amount: input.amount,
      currency: input.currency ?? "USD",
      status: input.status ?? "pending",
      recordedAt: new Date().toISOString(),
    })
    .run();
  return db
    .select()
    .from(freelanceEarnings)
    .where(eq(freelanceEarnings.id, id))
    .get() as EarningRow;
}

export async function listEarnings(limit = 100): Promise<EarningRow[]> {
  const tenantId = getActiveTenantId();
  return db
    .select()
    .from(freelanceEarnings)
    .where(eq(freelanceEarnings.tenantId, tenantId))
    .orderBy(desc(freelanceEarnings.recordedAt))
    .limit(limit)
    .all();
}

export async function earningsSummary(): Promise<{
  totalPaid: number;
  totalPending: number;
  byPlatform: Record<string, number>;
}> {
  const tenantId = getActiveTenantId();
  const rows = db
    .select({
      platform: freelanceEarnings.platform,
      status: freelanceEarnings.status,
      total: sql<number>`COALESCE(sum(${freelanceEarnings.amount}), 0)`,
    })
    .from(freelanceEarnings)
    .where(eq(freelanceEarnings.tenantId, tenantId))
    .groupBy(freelanceEarnings.platform, freelanceEarnings.status)
    .all();

  let totalPaid = 0;
  let totalPending = 0;
  const byPlatform: Record<string, number> = {};
  for (const row of rows) {
    if (row.status === "paid") totalPaid += row.total;
    if (row.status === "pending" || row.status === "invoiced")
      totalPending += row.total;
    byPlatform[row.platform] = (byPlatform[row.platform] ?? 0) + row.total;
  }
  return { totalPaid, totalPending, byPlatform };
}
