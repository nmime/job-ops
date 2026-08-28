/**
 * Profile-campaign state helpers (docs/freelance-profile-campaign.md).
 *
 * Read/write/verify primitives for the three campaign tables:
 *   freelance_profiles          platform -> completeness/status/fields JSON
 *   freelance_profile_actions   every fill/post/publish/promote attempt
 *   freelance_profile_content   gigs / posts / portfolio items / applications
 *
 * Verification rule (spec): a field is marked `done` only after a confirmed
 * re-read through its backend; the proof (API response snippet / selector hit
 * / operator report) is stored as `evidence` on the field and on the action
 * row. `user_only` fields are never written by any backend.
 */
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../../../db";
import {
  fieldNamesFor,
  getProfilePlatform,
  type ProfileBackend,
  type ProfilePlatformSpec,
} from "./platforms";

const {
  freelanceProfiles,
  freelanceProfileActions,
  freelanceProfileContent,
} = schema;

// --- Types -------------------------------------------------------------------

export const PROFILE_FIELD_STATUSES = [
  "pending",
  "done",
  "user_only",
  "blocked",
  "skipped",
] as const;
export type ProfileFieldStatus = (typeof PROFILE_FIELD_STATUSES)[number];

export interface ProfileFieldState {
  status: ProfileFieldStatus;
  value?: string;
  /** ISO time of the last confirmed re-read. */
  verified_at?: string;
  evidence?: string;
}

export type ProfileFieldsState = Record<string, ProfileFieldState>;

export type ProfileRowStatus =
  | "in_progress"
  | "complete"
  | "blocked"
  | "not-applicable"
  | string;

export interface ProfileActionRecord {
  platform: string;
  kind: "fill" | "post" | "publish" | "promote";
  target?: string;
  payload?: unknown;
  status: "pending" | "done" | "error" | "user_only";
  evidence?: unknown;
}

export interface ProfileContentRecord {
  platform: string;
  kind: "gig" | "post" | "portfolio_item" | "community_apply" | string;
  title: string;
  status: "drafted" | "published" | "error" | string;
  externalRef?: string;
}

export interface OperatorFieldReport {
  status?: ProfileFieldStatus;
  value?: string;
  evidence?: string;
}

export interface OperatorReport {
  completeness?: string;
  status?: ProfileRowStatus;
  fields?: Record<string, OperatorFieldReport>;
  /** Pending action ids the operator completed (browser_mac step list). */
  completedActionIds?: Array<number | string>;
  /** Content rows reported (matched by kind+title, created if missing). */
  content?: Array<
    ProfileContentRecord & { id?: number; externalRef?: string }
  >;
  note?: string;
}

// --- Field state ---------------------------------------------------------------

function parseFields(json: string | null): ProfileFieldsState {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Recompute the completeness percentage from field states:
 * done / (all fields except user_only). "n/a" for platforms with no fields.
 */
export function computeCompleteness(
  fields: ProfileFieldsState,
): string | null {
  const names = Object.keys(fields);
  const counted = names.filter((n) => fields[n]?.status !== "user_only");
  if (counted.length === 0) return null;
  const done = counted.filter((n) => fields[n]?.status === "done").length;
  return `${Math.round((done / counted.length) * 100)}%`;
}

// --- Profiles ------------------------------------------------------------------

export interface ProfileUpsert {
  profileUrl?: string | null;
  completeness?: string | null;
  status?: ProfileRowStatus;
  /** Merged into the existing field states (partial per-field patches ok). */
  fields?: Record<string, Partial<ProfileFieldState>>;
}

/** Read one profile row (DB only, may be null when unseeded). */
export function getProfileRow(platform: string) {
  return db
    .select()
    .from(freelanceProfiles)
    .where(eq(freelanceProfiles.platform, platform))
    .get();
}

export function listProfileRows() {
  return db.select().from(freelanceProfiles).all();
}

/**
 * Insert or update a campaign profile row, merging field states.
 * `completeness` is recomputed from the merged fields unless overridden.
 */
export function upsertProfile(
  platform: string,
  patch: ProfileUpsert,
): (typeof freelanceProfiles.$inferSelect) {
  const existing = getProfileRow(platform);
  const fields: ProfileFieldsState = {
    ...parseFields(existing?.fields ?? null),
  };
  if (patch.fields) {
    for (const [name, f] of Object.entries(patch.fields)) {
      fields[name] = { ...(fields[name] ?? { status: "pending" }), ...f };
    }
  }
  const completeness =
    patch.completeness !== undefined
      ? patch.completeness
      : (computeCompleteness(fields) ?? existing?.completeness ?? null);
  const next = {
    platform,
    profileUrl: patch.profileUrl !== undefined ? patch.profileUrl : existing?.profileUrl ?? null,
    completeness,
    status: patch.status ?? existing?.status ?? "in_progress",
    fields: JSON.stringify(fields, null, 1),
    updatedAt: nowIso(),
  };
  if (existing) {
    db.update(freelanceProfiles)
      .set(next)
      .where(eq(freelanceProfiles.platform, platform))
      .run();
    return { ...existing, ...next };
  }
  db.insert(freelanceProfiles).values(next).run();
  return next as (typeof freelanceProfiles.$inferSelect);
}

/** Patch a single field's state (merge). */
export function setFieldState(
  platform: string,
  field: string,
  patch: Partial<ProfileFieldState>,
) {
  const row = getProfileRow(platform);
  const fields = parseFields(row?.fields ?? null);
  fields[field] = {
    ...(fields[field] ?? { status: "pending" }),
    ...patch,
  };
  upsertProfile(platform, {
    fields: { [field]: fields[field] },
  });
}

/** Mark a field verified (done + verified_at + evidence) — after a re-read. */
export function verifyField(
  platform: string,
  field: string,
  evidence: string,
  value?: string,
) {
  setFieldState(platform, field, {
    status: "done",
    evidence,
    verified_at: nowIso(),
    ...(value !== undefined ? { value } : {}),
  });
}

// --- Actions -------------------------------------------------------------------

/**
 * Record an action attempt. For browser_mac/browser_sandbox backends this is
 * the persisted `pending` step list the operator picks up.
 */
export function recordProfileAction(
  input: ProfileActionRecord,
): (typeof freelanceProfileActions.$inferSelect) {
  const result = db
    .insert(freelanceProfileActions)
    .values({
      platform: input.platform,
      kind: input.kind,
      target: input.target ?? null,
      payload: input.payload !== undefined ? JSON.stringify(input.payload) : null,
      status: input.status,
      evidence:
        input.evidence !== undefined
          ? (typeof input.evidence === "string"
              ? input.evidence
              : JSON.stringify(input.evidence))
          : null,
      createdAt: nowIso(),
      completedAt:
        input.status === "done" || input.status === "error"
          ? nowIso()
          : null,
    })
    .returning()
    .all();
  return result[0];
}

export function listProfileActions(filter?: {
  platform?: string;
  status?: string;
  kind?: string;
  limit?: number;
}) {
  const conds = [];
  if (filter?.platform) conds.push(eq(freelanceProfileActions.platform, filter.platform));
  if (filter?.status) conds.push(eq(freelanceProfileActions.status, filter.status));
  if (filter?.kind) conds.push(eq(freelanceProfileActions.kind, filter.kind));
  const rows = conds.length
    ? db
        .select()
        .from(freelanceProfileActions)
        .where(and(...conds))
        .orderBy(asc(freelanceProfileActions.id))
        .all()
    : db.select().from(freelanceProfileActions).orderBy(asc(freelanceProfileActions.id)).all();
  return filter?.limit ? rows.slice(0, filter.limit) : rows;
}

export function getProfileAction(id: number) {
  return db
    .select()
    .from(freelanceProfileActions)
    .where(eq(freelanceProfileActions.id, id))
    .get();
}

export function completeProfileAction(
  id: number,
  patch: { status: "done" | "error" | "user_only"; evidence?: unknown },
) {
  db.update(freelanceProfileActions)
    .set({
      status: patch.status,
      evidence:
        patch.evidence !== undefined
          ? (typeof patch.evidence === "string"
              ? patch.evidence
              : JSON.stringify(patch.evidence))
          : undefined,
      completedAt: nowIso(),
    })
    .where(eq(freelanceProfileActions.id, id))
    .run();
  return getProfileAction(id);
}

/**
 * Find the pending action for (platform, kind) — the browser_mac step list.
 * Null when none is queued (idempotency: we reuse it instead of duplicating).
 */
export function getPendingAction(platform: string, kind: string) {
  return (
    db
      .select()
      .from(freelanceProfileActions)
      .where(
        and(
          eq(freelanceProfileActions.platform, platform),
          eq(freelanceProfileActions.kind, kind),
          eq(freelanceProfileActions.status, "pending"),
        ),
      )
      .orderBy(asc(freelanceProfileActions.id))
      .all()[0] ?? null
  );
}

// --- Content (idempotent) ---------------------------------------------------------

/**
 * Idempotent content upsert: one row per (platform, kind, title).
 * Re-runs never create duplicate gigs/posts.
 */
export function upsertProfileContent(
  input: ProfileContentRecord & { externalRef?: string },
): (typeof freelanceProfileContent.$inferSelect) & { created: boolean } {
  const existing = db
    .select()
    .from(freelanceProfileContent)
    .where(
      and(
        eq(freelanceProfileContent.platform, input.platform),
        eq(freelanceProfileContent.kind, input.kind),
        eq(freelanceProfileContent.title, input.title),
      ),
    )
    .all()[0];
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (input.status && input.status !== existing.status) patch.status = input.status;
    if (input.externalRef) patch.externalRef = input.externalRef;
    if (input.status === "published" && !existing.publishedAt) {
      patch.publishedAt = nowIso();
    }
    if (Object.keys(patch).length > 0) {
      db.update(freelanceProfileContent)
        .set(patch)
        .where(eq(freelanceProfileContent.id, existing.id))
        .run();
    }
    return { ...existing, ...(patch as object), created: false };
  }
  const row = db
    .insert(freelanceProfileContent)
    .values({
      platform: input.platform,
      kind: input.kind,
      title: input.title,
      status: input.status ?? "drafted",
      externalRef: input.externalRef ?? null,
      createdAt: nowIso(),
      publishedAt: input.status === "published" ? nowIso() : null,
    })
    .returning()
    .all()[0];
  return { ...row, created: true };
}

export function listProfileContent(platform?: string, kind?: string) {
  const conds = [];
  if (platform) conds.push(eq(freelanceProfileContent.platform, platform));
  if (kind) conds.push(eq(freelanceProfileContent.kind, kind));
  return conds.length
    ? db
        .select()
        .from(freelanceProfileContent)
        .where(and(...conds))
        .orderBy(asc(freelanceProfileContent.id))
        .all()
    : db.select().from(freelanceProfileContent).orderBy(asc(freelanceProfileContent.id)).all();
}

// --- Operator (browser_mac) results ------------------------------------------------

/**
 * Apply an operator-reported result (POST /api/freelance/profiles/:platform/record):
 * field states, completed pending actions, content rows, row status.
 * Returns the updated merged profile view.
 */
export function applyOperatorReport(
  platform: string,
  report: OperatorReport,
): { profile: MergedProfile; updated: Record<string, unknown> } {
  const spec = getProfilePlatform(platform);
  if (!spec) throw new Error(`unknown profile platform: ${platform}`);

  const fieldPatch: Record<string, Partial<ProfileFieldState>> = {};
  const fieldUpdates: Record<string, string> = {};
  const existingFields = parseFields(getProfileRow(platform)?.fields ?? null);
  if (report.fields) {
    for (const [name, f] of Object.entries(report.fields)) {
      // Accept registry fields, fields already present in the DB row
      // (e.g. platform-specific extras like upwork's `city`), or any
      // report that carries a value.
      if (!fieldNamesFor(spec).includes(name) && !existingFields[name] && !f.value) {
        continue;
      }
      const patch: Partial<ProfileFieldState> = {};
      if (f.status) patch.status = f.status;
      if (f.value !== undefined) patch.value = f.value;
      if (f.evidence !== undefined) patch.evidence = f.evidence;
      if (f.status === "done") {
        patch.verified_at = nowIso();
        fieldUpdates[name] = f.evidence ?? "operator report";
      }
      if (Object.keys(patch).length) fieldPatch[name] = patch;
    }
  }

  const actionUpdates: string[] = [];
  if (report.completedActionIds?.length) {
    for (const raw of report.completedActionIds) {
      const id = Number.parseInt(String(raw), 10);
      if (!Number.isFinite(id)) continue;
      const action = getProfileAction(id);
      if (!action || action.platform !== platform) continue;
      completeProfileAction(id, {
        status: "done",
        evidence: report.note ?? "operator report",
      });
      actionUpdates.push(`${action.kind} (#${id})`);
    }
  }

  const contentUpdates: string[] = [];
  if (report.content?.length) {
    for (const c of report.content) {
      const saved = upsertProfileContent({
        platform,
        kind: c.kind,
        title: c.title,
        status: c.status,
        externalRef: c.externalRef,
      });
      contentUpdates.push(`${c.kind}: ${c.title} (${saved.status})`);
    }
  }

  const profile = upsertProfile(platform, {
    fields: Object.keys(fieldPatch).length ? fieldPatch : undefined,
    status: report.status,
    completeness: report.completeness,
  });

  return {
    profile: getMergedProfile(platform)!,
    updated: {
      fields: fieldUpdates,
      actions: actionUpdates,
      content: contentUpdates,
      profileStatus: profile.status,
      completeness: profile.completeness,
    },
  };
}

// --- Merged view (registry + DB) ----------------------------------------------------

export interface MergedProfile {
  platform: string;
  name: string;
  backend: ProfileBackend;
  profileUrl: string;
  completeness: string | null;
  status: ProfileRowStatus;
  notes: string[];
  fields: ProfileFieldsState;
  pendingSteps: Array<{
    id: number;
    kind: string;
    target: string | null;
    steps: string[];
    createdAt: string;
  }>;
  content: Array<{
    id: number;
    kind: string;
    title: string;
    status: string;
    externalRef: string | null;
  }>;
}

/**
 * Registry + DB merged state for one platform. Every registry field appears in
 * `fields` (unseeded fields default to `pending`, user-only fields to
 * `user_only`).
 */
export function getMergedProfile(platform: string): MergedProfile | null {
  const spec = getProfilePlatform(platform);
  if (!spec) return null;
  const row = getProfileRow(platform);
  const dbFields = parseFields(row?.fields ?? null);
  const fields: ProfileFieldsState = {};
  for (const f of spec.fields) {
    const stored = dbFields[f.name];
    fields[f.name] = stored ?? (f.userOnly ? { status: "user_only" } : { status: "pending" });
  }
  // Keep any extra fields present in the DB (e.g. platform-specific) even if
  // the registry changes later.
  for (const [name, stored] of Object.entries(dbFields)) {
    if (!fields[name]) fields[name] = stored;
  }
  const pending = listProfileActions({ platform, status: "pending" }).map(
    (a) => ({
      id: a.id,
      kind: a.kind,
      target: a.target,
      steps:
        a.payload && typeof a.payload === "string" && a.payload.trim().startsWith("[")
          ? (() => {
              try {
                const parsed = JSON.parse(a.payload);
                return Array.isArray(parsed) ? parsed.map(String) : [];
              } catch {
                return [];
              }
            })()
          : [],
      createdAt: a.createdAt,
    }),
  );
  const content = listProfileContent(platform).map((c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title ?? "",
    status: c.status,
    externalRef: c.externalRef,
  }));
  return {
    platform: spec.id,
    name: spec.name,
    backend: spec.backend,
    profileUrl: row?.profileUrl || spec.profileUrl,
    completeness: row?.completeness ?? null,
    status: row?.status ?? "in_progress",
    notes: [...(spec.notes ?? [])],
    fields,
    pendingSteps: pending,
    content,
  };
}

export function listMergedProfiles(platforms?: string[]): MergedProfile[] {
  const ids = platforms?.length ? platforms : PROFILE_ALL_IDS;
  return ids
    .map((id) => getMergedProfile(id))
    .filter((p): p is MergedProfile => p !== null);
}

const PROFILE_ALL_IDS = [
  "upwork",
  "freelancer",
  "fiverr",
  "toptal",
  "turing",
  "arc-dev",
  "peopleperhour",
  "guru",
  "flexjobs",
  "malt",
  "wellfound",
  "braintrust",
  "contra",
  "weworkremotely",
];
