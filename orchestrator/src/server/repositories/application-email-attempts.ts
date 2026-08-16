import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { getActiveTenantId } from "../tenancy/context";

const { applicationEmailAttempts } = schema;

export type ApplicationEmailAttemptStatus =
  | "pending"
  | "sent"
  | "failed_transient"
  | "failed_permanent";

export type ApplicationEmailAttempt = {
  id: string;
  tenantId: string;
  jobId: string;
  intendedRecipient: string;
  resolvedRecipient: string;
  subject: string;
  contentHash: string;
  status: ApplicationEmailAttemptStatus;
  providerMessageId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapRow(
  row: typeof applicationEmailAttempts.$inferSelect,
): ApplicationEmailAttempt {
  return {
    ...row,
    status: row.status as ApplicationEmailAttemptStatus,
  };
}

export async function findSuccessfulApplicationEmailAttempt(input: {
  jobId: string;
  resolvedRecipient: string;
  contentHash: string;
}): Promise<ApplicationEmailAttempt | null> {
  const tenantId = getActiveTenantId();
  const rows = await db
    .select()
    .from(applicationEmailAttempts)
    .where(
      and(
        eq(applicationEmailAttempts.tenantId, tenantId),
        eq(applicationEmailAttempts.jobId, input.jobId),
        eq(applicationEmailAttempts.resolvedRecipient, input.resolvedRecipient),
        eq(applicationEmailAttempts.contentHash, input.contentHash),
        eq(applicationEmailAttempts.status, "sent"),
      ),
    )
    .orderBy(desc(applicationEmailAttempts.updatedAt))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createApplicationEmailAttempt(input: {
  jobId: string;
  intendedRecipient: string;
  resolvedRecipient: string;
  subject: string;
  contentHash: string;
}): Promise<ApplicationEmailAttempt> {
  const now = new Date().toISOString();
  const id = randomUUID();
  const tenantId = getActiveTenantId();
  await db.insert(applicationEmailAttempts).values({
    id,
    tenantId,
    jobId: input.jobId,
    intendedRecipient: input.intendedRecipient,
    resolvedRecipient: input.resolvedRecipient,
    subject: input.subject,
    contentHash: input.contentHash,
    status: "pending",
    providerMessageId: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  });
  const rows = await db
    .select()
    .from(applicationEmailAttempts)
    .where(eq(applicationEmailAttempts.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`application email attempt ${id} not found after insert`);
  }
  return mapRow(row);
}

export async function updateApplicationEmailAttemptStatus(input: {
  id: string;
  status: ApplicationEmailAttemptStatus;
  providerMessageId?: string | null;
  failureReason?: string | null;
}): Promise<ApplicationEmailAttempt | null> {
  const now = new Date().toISOString();
  const tenantId = getActiveTenantId();
  await db
    .update(applicationEmailAttempts)
    .set({
      status: input.status,
      providerMessageId: input.providerMessageId ?? null,
      failureReason: input.failureReason ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(applicationEmailAttempts.tenantId, tenantId),
        eq(applicationEmailAttempts.id, input.id),
      ),
    );
  const rows = await db
    .select()
    .from(applicationEmailAttempts)
    .where(
      and(
        eq(applicationEmailAttempts.tenantId, tenantId),
        eq(applicationEmailAttempts.id, input.id),
      ),
    )
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}
