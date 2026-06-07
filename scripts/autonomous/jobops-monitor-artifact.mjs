#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const requireFromCwd = createRequire(`${process.cwd()}/package.json`);
const Database = requireFromCwd("better-sqlite3");

const DEFAULT_DB_PATH = "/app/data/jobs.db";
const DEFAULT_LOCAL_PORT = "3001";
const DEFAULT_TIMEOUT_MS = 5000;
const TRUE_PORTAL_NOTE = "submitted portal application via browser automation";

const STAGE_QUERIES = [
  {
    name: "stage_events.true_portal_submitted",
    category: "true_portal_submitted",
    description:
      "Real portal submits only: structured reasonCode=portal_submitted or exact legacy metadata/note, with occurred_at present.",
    sql: `select count(*) as count, min(occurred_at) as first_timestamp, max(occurred_at) as last_timestamp
from stage_events
where occurred_at is not null
  and (
    (json_valid(metadata) and json_extract(metadata, '$.reasonCode') = 'portal_submitted')
    or metadata = '${TRUE_PORTAL_NOTE}'
    or (json_valid(metadata) and json_extract(metadata, '$.note') = '${TRUE_PORTAL_NOTE}')
  )`,
  },
  {
    name: "stage_events.portal_needs_review",
    category: "portal_needs_review",
    description:
      "Portal records that require human review, counted separately from true submitted portal applications.",
    sql: `select count(*) as count, min(occurred_at) as first_timestamp, max(occurred_at) as last_timestamp
from stage_events
where occurred_at is not null
  and (
    outcome = 'needs_human'
    or (
      json_valid(metadata)
      and json_extract(metadata, '$.reasonCode') in (
        'portal_needs_review',
        'portal_needs_human',
        'portal_session_required',
        'needs_portal_session',
        'direct_portal_application_required',
        'portal_captcha_required'
      )
    )
  )`,
  },
  {
    name: "stage_events.portal_dry_run_no_submit",
    category: "portal_dry_run_no_submit",
    description:
      "Portal dry-run/no-submit markers, counted separately from true submitted portal applications.",
    sql: `select count(*) as count, min(occurred_at) as first_timestamp, max(occurred_at) as last_timestamp
from stage_events
where occurred_at is not null
  and json_valid(metadata)
  and (
    json_extract(metadata, '$.reasonCode') in (
      'portal_pre_submit_dry_run',
      'pre_submit_dry_run',
      'portal_no_submit',
      'no_submit_button',
      'no_submit_control'
    )
    or json_extract(metadata, '$.note') = 'Full-auto portal submit is disabled or dry-run; skipped before any real submit click.'
  )`,
  },
];

const SUMMARY_QUERIES = [
  {
    name: "jobs.by_status",
    sourceTable: "jobs",
    sql: "select status, count(*) as count from jobs group by status order by status",
  },
  {
    name: "pipeline_runs.by_status",
    sourceTable: "pipeline_runs",
    sql: "select status, count(*) as count from pipeline_runs group by status order by status",
  },
  {
    name: "pipeline_runs.stale_active",
    sourceTable: "pipeline_runs",
    sql: "select id, started_at, status from pipeline_runs where status in ('pending','running') order by started_at",
  },
  {
    name: "application_email_attempts.by_status",
    sourceTable: "application_email_attempts",
    sql: "select status, count(*) as count from application_email_attempts group by status order by status",
  },
  {
    name: "post_application_sync_runs.by_status",
    sourceTable: "post_application_sync_runs",
    sql: "select status, count(*) as count from post_application_sync_runs group by status order by status",
  },
  {
    name: "post_application_messages.by_processing_status",
    sourceTable: "post_application_messages",
    sql: "select processing_status, classification_label, message_type, count(*) as count from post_application_messages group by processing_status, classification_label, message_type order by count desc",
  },
  {
    name: "jobs.queued",
    sourceTable: "jobs",
    sql: "select status, count(*) as count from jobs where status in ('ready','retry','manual','needs_manual','updated') group by status order by status",
  },
  {
    name: "jobs.active_closed_items",
    sourceTable: "jobs",
    sql: "select status, outcome, count(*) as count from jobs where status='in_progress' group by status, outcome order by outcome",
  },
];

function normalizeBaseUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

export function resolvePublicHealthUrl(env = process.env) {
  const explicitEnvKey = env.JOBOPS_AUTONOMOUS_PUBLIC_HEALTH_URL
    ? "JOBOPS_AUTONOMOUS_PUBLIC_HEALTH_URL"
    : env.JOBOPS_PUBLIC_HEALTH_URL
      ? "JOBOPS_PUBLIC_HEALTH_URL"
      : null;
  const explicit = normalizeBaseUrl(
    explicitEnvKey ? env[explicitEnvKey] : null,
  );
  if (explicit && explicitEnvKey) {
    return explicit.endsWith("/health")
      ? { url: explicit, source: `env:${explicitEnvKey}` }
      : {
          url: `${explicit}/health`,
          source: `env:${explicitEnvKey}`,
        };
  }

  const base = normalizeBaseUrl(
    env.JOBOPS_PUBLIC_BASE_URL ?? env.PUBLIC_BASE_URL,
  );
  if (base) {
    return {
      url: `${base}/health`,
      source: env.JOBOPS_PUBLIC_BASE_URL
        ? "env:JOBOPS_PUBLIC_BASE_URL"
        : "env:PUBLIC_BASE_URL",
    };
  }

  const localPort = env.PORT?.trim() || DEFAULT_LOCAL_PORT;
  return {
    url: `http://127.0.0.1:${localPort}/health`,
    source: env.PORT ? "local:PORT" : "local:default-port-3001",
  };
}

function toEpoch(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function tableExists(db, tableName) {
  const row = db
    .prepare(
      "select 1 as present from sqlite_master where type='table' and name=?",
    )
    .get(tableName);
  return Boolean(row?.present);
}

function runCountQuery(db, query, dbPath) {
  if (!tableExists(db, "stage_events")) {
    return {
      name: query.name,
      category: query.category,
      description: query.description,
      source: { type: "sqlite", path: dbPath, table: "stage_events" },
      sql: query.sql,
      count: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      skipped: "stage_events table missing",
    };
  }
  const row = db.prepare(query.sql).get();
  return {
    name: query.name,
    category: query.category,
    description: query.description,
    source: { type: "sqlite", path: dbPath, table: "stage_events" },
    sql: query.sql,
    count: Number(row?.count ?? 0),
    firstTimestamp: toEpoch(row?.first_timestamp),
    lastTimestamp: toEpoch(row?.last_timestamp),
  };
}

function runSummaryQuery(db, query, dbPath) {
  if (!tableExists(db, query.sourceTable)) {
    return {
      name: query.name,
      source: { type: "sqlite", path: dbPath, table: query.sourceTable },
      sql: query.sql,
      rows: [],
      skipped: `${query.sourceTable} table missing`,
    };
  }
  return {
    name: query.name,
    source: { type: "sqlite", path: dbPath, table: query.sourceTable },
    sql: query.sql,
    rows: db.prepare(query.sql).all(),
  };
}

function readJsonIfPresent(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function countActions(results = []) {
  const counts = {};
  for (const result of results) {
    const action =
      typeof result?.action === "string" ? result.action : "unknown";
    counts[action] = (counts[action] ?? 0) + 1;
  }
  return counts;
}

const ROUTE_TAXONOMY_COLUMNS = [
  "job_id",
  "tenant_id",
  "run_id",
  "title",
  "employer",
  "job_url",
  "application_link",
  "emails",
  "applied_at",
  "has_sent_email_attempt",
  "application_link_is_mailto",
  "ready_drain_email_sent",
  "ready_drain_resolved_email",
  "ready_drain_portal_submitted",
  "applied_email_route",
  "applied_portal_only",
];

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function tableColumns(db, tableName) {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(
    db
      .prepare(`pragma table_info(${quoteIdentifier(tableName)})`)
      .all()
      .map((column) => column.name),
  );
}

function optionalColumn(columns, name, fallback = "null") {
  return columns.has(name) ? name : `${fallback} as ${name}`;
}

function buildReadyDrainRouteEvidence(readyDrainResultPath) {
  const readyDrain = readJsonIfPresent(readyDrainResultPath);
  const byJobId = new Map();
  const byRunId = new Map();

  const remember = (map, key, evidence) => {
    if (!key) return;
    const current = map.get(key) ?? {
      emailSent: false,
      resolvedEmail: false,
      portalSubmitted: false,
    };
    current.emailSent ||= evidence.emailSent;
    current.resolvedEmail ||= evidence.resolvedEmail;
    current.portalSubmitted ||= evidence.portalSubmitted;
    map.set(key, current);
  };

  for (const result of readyDrain?.results ?? []) {
    const action = typeof result?.action === "string" ? result.action : null;
    const evidence = {
      emailSent: action === "email_sent",
      resolvedEmail: Boolean(result?.resolvedEmail),
      portalSubmitted: action === "portal_submitted",
    };
    if (
      !evidence.emailSent &&
      !evidence.resolvedEmail &&
      !evidence.portalSubmitted
    ) {
      continue;
    }
    const jobId =
      result?.jobId ??
      result?.job_id ??
      result?.applicationId ??
      result?.application_id;
    const runId =
      result?.runId ??
      result?.run_id ??
      result?.pipelineRunId ??
      result?.pipeline_run_id;
    remember(byJobId, jobId, evidence);
    remember(byRunId, runId, evidence);
  }

  const stats = readyDrain?.stats ?? {};
  const aggregate = {
    emailSent: Number(stats.emailSent ?? stats.sentEmail ?? 0) > 0,
    resolvedEmail: Number(stats.resolvedEmail ?? 0) > 0,
    portalSubmitted: Number(stats.portalSubmitted ?? 0) > 0,
  };

  return {
    available: Boolean(readyDrain),
    byJobId,
    byRunId,
    aggregate:
      aggregate.emailSent ||
      aggregate.resolvedEmail ||
      aggregate.portalSubmitted
        ? aggregate
        : null,
  };
}

function getReadyDrainEvidence(routeEvidence, jobId, runId) {
  return (
    routeEvidence.byJobId.get(jobId) ??
    routeEvidence.byRunId.get(runId) ??
    (routeEvidence.byJobId.size === 0 && routeEvidence.byRunId.size === 0
      ? routeEvidence.aggregate
      : null)
  );
}

function hasMailto(value) {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase().startsWith("mailto:")
  );
}

function buildRouteTaxonomySummary(rows) {
  return rows.reduce(
    (summary, row) => {
      summary.appliedTotal += 1;
      summary.appliedEmailRoute += row.applied_email_route;
      summary.appliedPortalOnly += row.applied_portal_only;
      summary.applied_total = summary.appliedTotal;
      summary.applied_email_route = summary.appliedEmailRoute;
      summary.applied_portal_only = summary.appliedPortalOnly;
      return summary;
    },
    {
      appliedTotal: 0,
      appliedEmailRoute: 0,
      appliedPortalOnly: 0,
      applied_total: 0,
      applied_email_route: 0,
      applied_portal_only: 0,
    },
  );
}

function buildAppliedRouteTaxonomy(db, dbPath, readyDrainResultPath, runId) {
  if (!tableExists(db, "jobs")) {
    return {
      name: "jobs.applied_route_taxonomy",
      source: { type: "sqlite", path: dbPath, table: "jobs" },
      description:
        "Applied-at jobs classified by email route before portal-only URL fallback.",
      rows: [],
      summary: {
        appliedTotal: 0,
        appliedEmailRoute: 0,
        appliedPortalOnly: 0,
        applied_total: 0,
        applied_email_route: 0,
        applied_portal_only: 0,
      },
      columns: ROUTE_TAXONOMY_COLUMNS,
      skipped: "jobs table missing",
    };
  }

  const jobColumns = tableColumns(db, "jobs");
  if (!jobColumns.has("id") || !jobColumns.has("applied_at")) {
    return {
      name: "jobs.applied_route_taxonomy",
      source: { type: "sqlite", path: dbPath, table: "jobs" },
      description:
        "Applied-at jobs classified by email route before portal-only URL fallback.",
      rows: [],
      summary: {
        appliedTotal: 0,
        appliedEmailRoute: 0,
        appliedPortalOnly: 0,
        applied_total: 0,
        applied_email_route: 0,
        applied_portal_only: 0,
      },
      columns: ROUTE_TAXONOMY_COLUMNS,
      skipped: "jobs id/applied_at columns missing",
    };
  }

  const emailAttemptColumns = tableColumns(db, "application_email_attempts");
  const hasEmailAttempts =
    emailAttemptColumns.has("job_id") && emailAttemptColumns.has("status");
  const jobSelect = [
    "id",
    optionalColumn(jobColumns, "tenant_id", "'tenant_default'"),
    optionalColumn(jobColumns, "title", "''"),
    optionalColumn(jobColumns, "employer", "''"),
    optionalColumn(jobColumns, "job_url", "''"),
    optionalColumn(jobColumns, "application_link"),
    optionalColumn(jobColumns, "emails", "''"),
    optionalColumn(jobColumns, "applied_at"),
  ].join(", ");
  const attemptTimestamp = emailAttemptColumns.has("updated_at")
    ? "attempts.updated_at"
    : emailAttemptColumns.has("created_at")
      ? "attempts.created_at"
      : "null";
  const sentEmailSelect = hasEmailAttempts
    ? `exists(
        select 1
        from application_email_attempts attempts
        where attempts.job_id = jobs.id
          and attempts.status = 'sent'
          and (
            ${attemptTimestamp} is null
            or abs(strftime('%s', ${attemptTimestamp}) - strftime('%s', jobs.applied_at)) <= 86400
          )
      ) as has_sent_email_attempt`
    : "0 as has_sent_email_attempt";
  const rows = db
    .prepare(`
      select ${jobSelect}, ${sentEmailSelect}
      from jobs
      where applied_at is not null
      order by applied_at, id
    `)
    .all();

  const readyDrainEvidence = buildReadyDrainRouteEvidence(readyDrainResultPath);
  const classifiedRows = rows.map((row) => {
    const readyDrain = getReadyDrainEvidence(readyDrainEvidence, row.id, runId);
    const applicationLinkIsMailto = hasMailto(row.application_link);
    const readyDrainEmailSent = Boolean(readyDrain?.emailSent);
    const readyDrainResolvedEmail = Boolean(readyDrain?.resolvedEmail);
    const readyDrainPortalSubmitted = Boolean(readyDrain?.portalSubmitted);
    const appliedEmailRoute =
      Boolean(row.has_sent_email_attempt) ||
      applicationLinkIsMailto ||
      readyDrainEmailSent ||
      readyDrainResolvedEmail;
    return {
      job_id: row.id,
      tenant_id: row.tenant_id,
      run_id: runId,
      title: row.title,
      employer: row.employer,
      job_url: row.job_url,
      application_link: row.application_link,
      emails: row.emails,
      applied_at: row.applied_at,
      has_sent_email_attempt: row.has_sent_email_attempt ? 1 : 0,
      application_link_is_mailto: applicationLinkIsMailto ? 1 : 0,
      ready_drain_email_sent: readyDrainEmailSent ? 1 : 0,
      ready_drain_resolved_email: readyDrainResolvedEmail ? 1 : 0,
      ready_drain_portal_submitted: readyDrainPortalSubmitted ? 1 : 0,
      applied_email_route: appliedEmailRoute ? 1 : 0,
      applied_portal_only: !appliedEmailRoute && row.job_url ? 1 : 0,
    };
  });

  return {
    name: "jobs.applied_route_taxonomy",
    source: { type: "sqlite", path: dbPath, table: "jobs" },
    description:
      "Applied-at jobs classified by email route before portal-only URL fallback.",
    rows: classifiedRows,
    summary: buildRouteTaxonomySummary(classifiedRows),
    columns: ROUTE_TAXONOMY_COLUMNS,
    readyDrainAvailable: readyDrainEvidence.available,
    applicationEmailAttemptsAvailable: tableExists(
      db,
      "application_email_attempts",
    ),
  };
}

function buildReadyDrainQueries(readyDrainResultPath, readyDrainLogPath) {
  const readyDrain = readJsonIfPresent(readyDrainResultPath);
  const actionCounts = countActions(readyDrain?.results ?? []);
  const dryRunNoSubmitActions = [
    "portal_pre_submit_dry_run",
    "no_submit_button",
    "no_submit_control",
    "portal_no_submit",
  ];
  const needsReviewActions = [
    "needs_portal_session",
    "portal_needs_review",
    "skipped_no_route",
  ];

  return [
    {
      name: "ready_drain.portal_submitted_actions",
      category: "ready_drain_portal_submitted_actions",
      description:
        "Ready-drain result actions only; provenance aid, not used as the true submitted counter.",
      source: {
        type: "json",
        path: readyDrainResultPath,
        logPath: readyDrainLogPath,
      },
      count: actionCounts.portal_submitted ?? 0,
      available: Boolean(readyDrain),
    },
    {
      name: "ready_drain.portal_needs_review_actions",
      category: "ready_drain_portal_needs_review_actions",
      description: "Ready-drain needs-review actions counted separately.",
      source: {
        type: "json",
        path: readyDrainResultPath,
        logPath: readyDrainLogPath,
      },
      count: Array.isArray(readyDrain?.results)
        ? needsReviewActions.reduce(
            (sum, action) => sum + (actionCounts[action] ?? 0),
            0,
          )
        : Number(readyDrain?.stats?.portalNeedsReview ?? 0),
      available: Boolean(readyDrain),
    },
    {
      name: "ready_drain.portal_dry_run_no_submit_actions",
      category: "ready_drain_portal_dry_run_no_submit_actions",
      description: "Ready-drain dry-run/no-submit actions counted separately.",
      source: {
        type: "json",
        path: readyDrainResultPath,
        logPath: readyDrainLogPath,
      },
      count: dryRunNoSubmitActions.reduce(
        (sum, action) => sum + (actionCounts[action] ?? 0),
        0,
      ),
      available: Boolean(readyDrain),
    },
  ];
}

async function checkPublicHealth(env, fetchImpl = globalThis.fetch) {
  const resolved = resolvePublicHealthUrl(env);
  if (env.JOBOPS_SKIP_PUBLIC_HEALTH_CHECK === "1") {
    return {
      ...resolved,
      status: "skipped",
      reason: "JOBOPS_SKIP_PUBLIC_HEALTH_CHECK=1",
    };
  }
  if (typeof fetchImpl !== "function") {
    return { ...resolved, status: "skipped", reason: "fetch unavailable" };
  }

  const timeoutMs = Math.max(
    100,
    Number.parseInt(env.JOBOPS_PUBLIC_HEALTH_TIMEOUT_MS ?? "", 10) ||
      DEFAULT_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(resolved.url, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      ...resolved,
      status: response.ok ? "ok" : "fail",
      httpStatus: response.status,
      timeoutMs,
    };
  } catch (error) {
    return {
      ...resolved,
      status: "fail",
      timeoutMs,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildMonitorArtifact(options = {}) {
  const env = options.env ?? process.env;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = env.JOBOPS_AUTONOMOUS_RUN_ID ?? null;
  const dbPath = options.dbPath ?? env.JOBOPS_DB_PATH ?? DEFAULT_DB_PATH;
  const ownsDb = !options.db;
  const db = options.db ?? new Database(dbPath, { readonly: true });
  const readyDrainResultPath =
    options.readyDrainResultPath ?? env.JOBOPS_READY_DRAIN_RESULT_PATH ?? null;
  const readyDrainLogPath =
    options.readyDrainLogPath ?? env.JOBOPS_READY_DRAIN_LOG_PATH ?? null;
  const artifactPath =
    options.artifactPath ?? env.JOBOPS_MONITOR_ARTIFACT_PATH ?? null;

  try {
    const stageQueries = STAGE_QUERIES.map((query) =>
      runCountQuery(db, query, dbPath),
    );
    const summaryQueries = SUMMARY_QUERIES.map((query) =>
      runSummaryQuery(db, query, dbPath),
    );
    const readyDrainQueries = buildReadyDrainQueries(
      readyDrainResultPath,
      readyDrainLogPath,
    );
    const routeTaxonomy = buildAppliedRouteTaxonomy(
      db,
      dbPath,
      readyDrainResultPath,
      runId,
    );
    const queries = [...stageQueries, ...readyDrainQueries];
    const queryByCategory = Object.fromEntries(
      queries.map((query) => [query.category, query]),
    );
    const publicHealth = await checkPublicHealth(
      env,
      options.fetchImpl ?? globalThis.fetch,
    );
    const artifact = {
      schemaVersion: 1,
      generatedAt,
      runId,
      artifactPath,
      sources: {
        database: dbPath,
        readyDrainResultPath,
        readyDrainLogPath,
      },
      publicHealth,
      counts: {
        truePortalSubmitted: queryByCategory.true_portal_submitted?.count ?? 0,
        portalNeedsReview:
          (queryByCategory.portal_needs_review?.count ?? 0) +
          (queryByCategory.ready_drain_portal_needs_review_actions?.count ?? 0),
        portalDryRunNoSubmit:
          (queryByCategory.portal_dry_run_no_submit?.count ?? 0) +
          (queryByCategory.ready_drain_portal_dry_run_no_submit_actions
            ?.count ?? 0),
        appliedEmailRoute: routeTaxonomy.summary.appliedEmailRoute,
        appliedPortalOnly: routeTaxonomy.summary.appliedPortalOnly,
      },
      queries,
      routeTaxonomy,
      summaryQueries,
    };

    if (artifactPath) {
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    }

    return artifact;
  } finally {
    if (ownsDb) db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildMonitorArtifact()
    .then((artifact) => {
      console.log(JSON.stringify(artifact, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
}
