import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildMonitorArtifact,
  resolvePublicHealthUrl,
} from "./jobops-monitor-artifact.mjs";

const requireFromCwd = createRequire(`${process.cwd()}/package.json`);
const Database = requireFromCwd("better-sqlite3");

let tempDir;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "jobops-monitor-artifact-"));
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createAppliedJobsDb(jobs) {
  const db = new Database(":memory:");
  db.exec(`
    create table stage_events (id text primary key, occurred_at integer, metadata text, outcome text);
    create table jobs (
      id text primary key,
      tenant_id text,
      title text,
      employer text,
      job_url text,
      application_link text,
      emails text,
      status text,
      outcome text,
      applied_at text
    );
  `);
  const insertJob = db.prepare(`
    insert into jobs (
      id,
      tenant_id,
      title,
      employer,
      job_url,
      application_link,
      emails,
      status,
      outcome,
      applied_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const job of jobs) {
    insertJob.run(
      job.id,
      job.tenant_id ?? "tenant_default",
      job.title ?? "Software Engineer",
      job.employer ?? "Example Employer",
      job.job_url ?? `https://jobs.example/${job.id}`,
      job.application_link ?? `https://jobs.example/${job.id}/apply`,
      job.emails ?? "",
      job.status ?? "applied",
      job.outcome ?? null,
      job.applied_at ?? "2026-06-07T02:00:00.000Z",
    );
  }
  return db;
}

describe("jobops monitor artifact", () => {
  it("counts true portal submissions only from structured/exact metadata", async () => {
    const dbPath = join(tempDir, "jobs.db");
    const db = new Database(dbPath);
    db.exec(`create table stage_events (
      id text primary key,
      occurred_at integer,
      metadata text,
      outcome text
    )`);
    const insert = db.prepare(
      "insert into stage_events (id, occurred_at, metadata, outcome) values (?, ?, ?, ?)",
    );
    insert.run(
      "structured",
      1770000001,
      JSON.stringify({
        reasonCode: "portal_submitted",
        note: "submitted via portal",
      }),
      null,
    );
    insert.run(
      "exact-note",
      1770000002,
      JSON.stringify({
        note: "submitted portal application via browser automation",
      }),
      null,
    );
    insert.run(
      "legacy-exact",
      1770000003,
      "submitted portal application via browser automation",
      null,
    );
    insert.run(
      "broad-text-no-count",
      1770000004,
      JSON.stringify({ note: "portal submit dry-run needs review" }),
      null,
    );
    insert.run(
      "missing-timestamp-no-count",
      null,
      JSON.stringify({ reasonCode: "portal_submitted" }),
      null,
    );
    insert.run(
      "needs-review",
      1770000005,
      JSON.stringify({ reasonCode: "portal_needs_review" }),
      "needs_human",
    );
    insert.run(
      "dry-run",
      1770000006,
      JSON.stringify({ reasonCode: "portal_pre_submit_dry_run" }),
      null,
    );
    db.close();

    const readyDrainResultPath = join(tempDir, "ready-drain-result.json");
    await writeFile(
      readyDrainResultPath,
      JSON.stringify({
        stats: { portalNeedsReview: 1 },
        results: [
          { action: "portal_pre_submit_dry_run" },
          { action: "needs_portal_session" },
        ],
      }),
    );

    const artifactPath = join(tempDir, "monitor-artifact.json");
    const artifact = await buildMonitorArtifact({
      dbPath,
      readyDrainResultPath,
      artifactPath,
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    const persisted = JSON.parse(await readFile(artifactPath, "utf8"));

    assert.equal(persisted.counts.truePortalSubmitted, 3);
    assert.equal(
      persisted.queries.find(
        (query) => query.name === "stage_events.true_portal_submitted",
      )?.source.table,
      "stage_events",
    );
    assert.equal(artifact.counts.truePortalSubmitted, 3);
    assert.equal(artifact.counts.portalDryRunNoSubmit, 2);
    assert.equal(artifact.counts.portalNeedsReview, 2);
    assert.equal(
      artifact.queries.find(
        (query) => query.name === "stage_events.true_portal_submitted",
      )?.firstTimestamp,
      1770000001,
    );
  });

  it("classifies dynamic sent email applications as email route before URL portal fallback", async () => {
    const db = new Database(":memory:");
    db.exec(`
      create table stage_events (id text primary key, occurred_at integer, metadata text, outcome text);
      create table jobs (
        id text primary key,
        tenant_id text,
        title text,
        employer text,
        job_url text,
        application_link text,
        emails text,
        status text,
        outcome text,
        applied_at text
      );
      create table application_email_attempts (
        id text primary key,
        job_id text,
        status text,
        updated_at text
      );
    `);
    db.prepare(`
      insert into jobs (
        id,
        tenant_id,
        title,
        employer,
        job_url,
        application_link,
        emails,
        status,
        outcome,
        applied_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "job-dynamic-email",
      "tenant_default",
      "Graduate Analyst",
      "Example Employer",
      "https://jobs.example/apply/123",
      "mailto:apply@example.com?subject=Graduate%20Analyst",
      "",
      "applied",
      null,
      "2026-06-07T01:02:03.000Z",
    );
    db.prepare(
      "insert into application_email_attempts (id, job_id, status, updated_at) values (?, ?, ?, ?)",
    ).run(
      "attempt-dynamic-email",
      "job-dynamic-email",
      "sent",
      "2026-06-07T01:03:00.000Z",
    );

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    db.close();

    assert.equal(artifact.counts.appliedEmailRoute, 1);
    assert.equal(artifact.counts.appliedPortalOnly, 0);
    assert.equal(artifact.routeTaxonomy.summary.appliedTotal, 1);
    assert.equal(artifact.routeTaxonomy.summary.appliedEmailRoute, 1);
    assert.equal(artifact.routeTaxonomy.summary.appliedPortalOnly, 0);
    assert.equal(artifact.routeTaxonomy.summary.applied_total, 1);
    assert.equal(artifact.routeTaxonomy.summary.applied_email_route, 1);
    assert.equal(artifact.routeTaxonomy.summary.applied_portal_only, 0);
    assert.deepEqual(artifact.routeTaxonomy.rows[0], {
      job_id: "job-dynamic-email",
      tenant_id: "tenant_default",
      run_id: null,
      title: "Graduate Analyst",
      employer: "Example Employer",
      job_url: "https://jobs.example/apply/123",
      application_link: "mailto:apply@example.com?subject=Graduate%20Analyst",
      emails: "",
      applied_at: "2026-06-07T01:02:03.000Z",
      has_sent_email_attempt: 1,
      application_link_is_mailto: 1,
      ready_drain_email_sent: 0,
      ready_drain_resolved_email: 0,
      ready_drain_portal_submitted: 0,
      applied_email_route: 1,
      applied_portal_only: 0,
    });
  });

  it("classifies ready-drain email_sent/resolvedEmail as email route evidence", async () => {
    const db = new Database(":memory:");
    db.exec(`
      create table stage_events (id text primary key, occurred_at integer, metadata text, outcome text);
      create table jobs (
        id text primary key,
        tenant_id text,
        title text,
        employer text,
        job_url text,
        application_link text,
        emails text,
        status text,
        outcome text,
        applied_at text
      );
    `);
    db.prepare(`
      insert into jobs (
        id,
        tenant_id,
        title,
        employer,
        job_url,
        application_link,
        emails,
        status,
        outcome,
        applied_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "job-ready-drain-email",
      "tenant_default",
      "Software Engineer",
      "Ready Drain Employer",
      "https://jobs.example/apply/456",
      "https://jobs.example/apply/456",
      "",
      "applied",
      null,
      "2026-06-07T02:00:00.000Z",
    );
    const readyDrainResultPath = join(tempDir, "ready-drain-email-result.json");
    await writeFile(
      readyDrainResultPath,
      JSON.stringify({
        results: [
          {
            jobId: "job-ready-drain-email",
            action: "email_sent",
            resolvedEmail: 1,
          },
        ],
      }),
    );

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      readyDrainResultPath,
      env: {
        JOBOPS_AUTONOMOUS_RUN_ID: "run-email",
        JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1",
      },
    });
    db.close();

    assert.equal(artifact.counts.appliedEmailRoute, 1);
    assert.equal(artifact.counts.appliedPortalOnly, 0);
    assert.equal(artifact.routeTaxonomy.rows[0].ready_drain_email_sent, 1);
    assert.equal(artifact.routeTaxonomy.rows[0].ready_drain_resolved_email, 1);
    assert.equal(artifact.routeTaxonomy.rows[0].applied_email_route, 1);
    assert.equal(artifact.routeTaxonomy.rows[0].applied_portal_only, 0);
  });

  it("uses ready-drain result id as row job id evidence", async () => {
    const db = createAppliedJobsDb([
      { id: "job-ready-drain-id", applied_at: "2026-06-07T02:00:00.000Z" },
      { id: "job-portal-only", applied_at: "2026-06-07T02:01:00.000Z" },
    ]);
    const readyDrainResultPath = join(tempDir, "ready-drain-id-result.json");
    await writeFile(
      readyDrainResultPath,
      JSON.stringify({
        results: [{ id: "job-ready-drain-id", action: "email_sent" }],
        stats: { emailSent: 1 },
      }),
    );

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      readyDrainResultPath,
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    db.close();

    const emailRow = artifact.routeTaxonomy.rows.find(
      (row) => row.job_id === "job-ready-drain-id",
    );
    const portalRow = artifact.routeTaxonomy.rows.find(
      (row) => row.job_id === "job-portal-only",
    );
    assert.equal(artifact.counts.appliedEmailRoute, 1);
    assert.equal(artifact.counts.appliedPortalOnly, 1);
    assert.equal(emailRow.ready_drain_email_sent, 1);
    assert.equal(emailRow.applied_email_route, 1);
    assert.equal(emailRow.applied_portal_only, 0);
    assert.equal(portalRow.ready_drain_email_sent, 0);
    assert.equal(portalRow.applied_email_route, 0);
    assert.equal(portalRow.applied_portal_only, 1);
  });

  it("does not blanket route rows from aggregate ready-drain emailSent", async () => {
    const db = createAppliedJobsDb([
      { id: "job-aggregate-one", applied_at: "2026-06-07T02:00:00.000Z" },
      { id: "job-aggregate-two", applied_at: "2026-06-07T02:01:00.000Z" },
    ]);
    const readyDrainResultPath = join(
      tempDir,
      "ready-drain-aggregate-result.json",
    );
    await writeFile(
      readyDrainResultPath,
      JSON.stringify({
        results: [],
        stats: { emailSent: 1 },
      }),
    );

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      readyDrainResultPath,
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    db.close();

    assert.equal(artifact.counts.appliedEmailRoute, 0);
    assert.equal(artifact.counts.appliedPortalOnly, 2);
    assert.equal(
      artifact.routeTaxonomy.readyDrainAggregateFallback,
      "disabled_no_row_identity",
    );
    assert.equal(
      artifact.routeTaxonomy.rows.every(
        (row) =>
          row.ready_drain_email_sent === 0 && row.applied_email_route === 0,
      ),
      true,
    );
  });

  it("does not classify non-mailto rows as email solely from aggregate ready-drain stats", async () => {
    const db = createAppliedJobsDb([
      {
        id: "job-no-email-attempt",
        application_link: "https://jobs.example/no-email-attempt/apply",
      },
    ]);
    const readyDrainResultPath = join(
      tempDir,
      "ready-drain-aggregate-non-mailto.json",
    );
    await writeFile(
      readyDrainResultPath,
      JSON.stringify({ stats: { emailSent: 1 } }),
    );

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      readyDrainResultPath,
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    db.close();

    assert.equal(artifact.counts.appliedEmailRoute, 0);
    assert.equal(artifact.counts.appliedPortalOnly, 1);
    assert.equal(artifact.routeTaxonomy.rows[0].has_sent_email_attempt, 0);
    assert.equal(artifact.routeTaxonomy.rows[0].application_link_is_mailto, 0);
    assert.equal(artifact.routeTaxonomy.rows[0].ready_drain_email_sent, 0);
    assert.equal(artifact.routeTaxonomy.rows[0].applied_email_route, 0);
    assert.equal(artifact.routeTaxonomy.rows[0].applied_portal_only, 1);
  });

  it("handles production summary tables while preserving query provenance", async () => {
    const db = new Database(":memory:");
    db.exec(`
      create table stage_events (id text primary key, occurred_at integer, metadata text, outcome text);
      create table jobs (status text, outcome text);
      create table pipeline_runs (id text, started_at text, status text);
      create table application_email_attempts (status text);
      create table post_application_sync_runs (status text);
      create table post_application_messages (processing_status text, classification_label text, message_type text);
    `);
    db.prepare("insert into jobs (status, outcome) values (?, ?)").run(
      "ready",
      null,
    );
    db.prepare(
      "insert into pipeline_runs (id, started_at, status) values (?, ?, ?)",
    ).run("run-1", "2026-06-07T00:00:00.000Z", "running");

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    db.close();

    assert.deepEqual(artifact.summaryQueries[0], {
      name: "jobs.by_status",
      source: { type: "sqlite", path: ":memory:", table: "jobs" },
      sql: "select status, count(*) as count from jobs group by status order by status",
      rows: [{ status: "ready", count: 1 }],
    });
    assert.equal(
      artifact.summaryQueries.some((query) => query.skipped),
      false,
    );
  });

  it("separates latest-run counters, snapshot totals, deltas, redacted matrix, and CAPTCHA summary", async () => {
    const dbPath = join(tempDir, "matrix-deltas.db");
    const db = new Database(dbPath);
    db.exec(`
      create table stage_events (
        id text primary key,
        application_id text,
        occurred_at integer,
        metadata text,
        outcome text
      );
      create table jobs (
        id text primary key,
        source text,
        title text,
        employer text,
        job_url text,
        job_url_direct text,
        application_link text,
        emails text,
        status text,
        outcome text,
        applied_at text
      );
    `);
    db.prepare(`
      insert into jobs (
        id,
        source,
        title,
        employer,
        job_url,
        job_url_direct,
        application_link,
        emails,
        status,
        outcome,
        applied_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "job-stage-captcha",
      "linkedin",
      "Secret Role Title",
      "Secret Employer",
      "https://www.linkedin.com/jobs/view/1",
      "https://boards.greenhouse.io/example/jobs/1",
      "https://boards.greenhouse.io/example/jobs/1",
      "private@example.test",
      "applied",
      null,
      "2026-06-07T03:00:00.000Z",
    );
    const insertStage = db.prepare(
      "insert into stage_events (id, application_id, occurred_at, metadata, outcome) values (?, ?, ?, ?, ?)",
    );
    insertStage.run(
      "submitted-1",
      "job-stage-captcha",
      1770000100,
      JSON.stringify({ reasonCode: "portal_submitted" }),
      null,
    );
    insertStage.run(
      "submitted-2",
      "job-stage-captcha",
      1770000200,
      JSON.stringify({ reasonCode: "portal_submitted" }),
      null,
    );
    insertStage.run(
      "needs-review-captcha",
      "job-stage-captcha",
      1770000300,
      JSON.stringify({
        portalOutcome: {
          reasonCode: "portal_captcha_required",
          status: "needs_review",
          domain: "boards.greenhouse.io",
          source: "linkedin",
          liveSubmitAttempted: true,
          submitClicked: false,
          captchaAttempted: true,
          captchaSolved: false,
        },
      }),
      "needs_human",
    );
    insertStage.run(
      "dry-run",
      "job-stage-captcha",
      1770000400,
      JSON.stringify({ reasonCode: "portal_pre_submit_dry_run" }),
      null,
    );
    db.close();

    const readyDrainResultPath = join(
      tempDir,
      "ready-drain-matrix-result.json",
    );
    await writeFile(
      readyDrainResultPath,
      JSON.stringify({
        startedAt: "2026-06-07T04:00:00.000Z",
        finishedAt: "2026-06-07T04:05:00.000Z",
        stats: { processed: 2, errors: 0 },
        results: [
          {
            jobId: "job-stage-captcha",
            action: "portal_submitted",
            source: "linkedin",
            domain: "https://boards.greenhouse.io/example/jobs/1",
            blockerReason: "portal_submitted",
            captcha: { attempted: true, solved: true, costUsd: 1.25 },
          },
          {
            action: "needs_portal_session",
            sourceBucket: "indeed",
            atsDomain: "https://tenant.myworkdayjobs.com/job/1",
            blocker_reason: "portal_session_required",
          },
        ],
      }),
    );
    const previousArtifactPath = join(
      tempDir,
      "previous-monitor-artifact.json",
    );
    await writeFile(
      previousArtifactPath,
      JSON.stringify({
        generatedAt: "2026-06-07T02:00:00.000Z",
        runId: "previous-run",
        snapshotTotals: {
          counts: {
            truePortalSubmitted: 1,
            portalNeedsReview: 0,
            portalDryRunNoSubmit: 0,
            appliedEmailRoute: 0,
            appliedPortalOnly: 0,
          },
        },
        sourceDomainBlockerMatrix: {
          snapshotTotals: [
            {
              sourceBucket: "linkedin",
              domainBucket: "greenhouse.io",
              blockerReasonBucket: "portal_captcha_required",
              count: 1,
            },
          ],
        },
      }),
    );

    const artifact = await buildMonitorArtifact({
      dbPath,
      readyDrainResultPath,
      previousArtifactPath,
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });

    assert.equal(artifact.counts.truePortalSubmitted, 2);
    assert.equal(artifact.counts.portalNeedsReview, 2);
    assert.equal(artifact.counts.portalDryRunNoSubmit, 1);
    assert.deepEqual(artifact.snapshotTotals.counts, {
      truePortalSubmitted: 2,
      portalNeedsReview: 1,
      portalDryRunNoSubmit: 1,
      appliedEmailRoute: 0,
      appliedPortalOnly: 1,
    });
    assert.equal(artifact.latestRun.available, true);
    assert.equal(artifact.latestRun.counts.truePortalSubmitted, 1);
    assert.equal(artifact.latestRun.counts.portalNeedsReview, 1);
    assert.deepEqual(artifact.latestRun.captcha, {
      available: true,
      attempts: 1,
      successes: 1,
      failures: 0,
      costUsd: 1.25,
    });
    assert.equal(artifact.snapshotTotals.captcha.available, true);
    assert.equal(artifact.snapshotTotals.captcha.attempts, 1);
    assert.equal(artifact.snapshotTotals.captcha.failures, 1);
    assert.equal(artifact.deltasSincePrevious.available, true);
    assert.equal(artifact.deltasSincePrevious.counts.truePortalSubmitted, 1);
    assert.equal(artifact.deltasSincePrevious.counts.portalNeedsReview, 1);
    assert.equal(artifact.deltasSincePrevious.counts.portalDryRunNoSubmit, 1);
    assert.deepEqual(artifact.deltasSincePrevious.sourceDomainBlockerMatrix, [
      {
        sourceBucket: "linkedin",
        domainBucket: "greenhouse.io",
        blockerReasonBucket: "portal_dry_run_no_submit",
        delta: 1,
      },
      {
        sourceBucket: "linkedin",
        domainBucket: "greenhouse.io",
        blockerReasonBucket: "portal_submitted",
        delta: 2,
      },
    ]);
    assert.deepEqual(artifact.sourceDomainBlockerMatrix.latestRun, [
      {
        sourceBucket: "indeed",
        domainBucket: "workday",
        blockerReasonBucket: "portal_session_required",
        count: 1,
      },
      {
        sourceBucket: "linkedin",
        domainBucket: "greenhouse.io",
        blockerReasonBucket: "portal_submitted",
        count: 1,
      },
    ]);
    assert.deepEqual(artifact.sourceDomainBlockerMatrix.snapshotTotals, [
      {
        sourceBucket: "linkedin",
        domainBucket: "greenhouse.io",
        blockerReasonBucket: "portal_submitted",
        count: 2,
      },
      {
        sourceBucket: "linkedin",
        domainBucket: "greenhouse.io",
        blockerReasonBucket: "portal_captcha_required",
        count: 1,
      },
      {
        sourceBucket: "linkedin",
        domainBucket: "greenhouse.io",
        blockerReasonBucket: "portal_dry_run_no_submit",
        count: 1,
      },
    ]);
    assert.equal(
      JSON.stringify(artifact.sourceDomainBlockerMatrix).includes(
        "Secret Role Title",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(artifact.sourceDomainBlockerMatrix).includes(
        "Secret Employer",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(artifact.sourceDomainBlockerMatrix).includes(
        "private@example.test",
      ),
      false,
    );
  });

  it("counts explicit ready-drain needs_review actions in query, latest-run, and legacy aggregate counts", async () => {
    const db = new Database(":memory:");
    db.exec(`
      create table stage_events (id text primary key, occurred_at integer, metadata text, outcome text);
    `);

    const readyDrainResultPath = join(
      tempDir,
      "ready-drain-needs-review-result.json",
    );
    await writeFile(
      readyDrainResultPath,
      JSON.stringify({
        stats: { portalNeedsReview: 1 },
        results: [
          {
            id: "ready-drain-needs-review-1",
            jobId: "job-needs-review-1",
            action: "needs_review",
          },
        ],
      }),
    );

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      readyDrainResultPath,
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    db.close();

    const needsReviewQuery = artifact.queries.find(
      (query) => query.category === "ready_drain_portal_needs_review_actions",
    );
    assert.equal(needsReviewQuery?.count, 1);
    assert.equal(artifact.latestRun.counts.portalNeedsReview, 1);
    assert.equal(artifact.snapshotTotals.counts.portalNeedsReview, 0);
    assert.equal(artifact.counts.portalNeedsReview, 1);
  });

  it("remains backward-compatible when ready-drain and previous artifacts are absent", async () => {
    const db = new Database(":memory:");
    db.exec(`
      create table stage_events (id text primary key, occurred_at integer, metadata text, outcome text);
    `);

    const artifact = await buildMonitorArtifact({
      db,
      dbPath: ":memory:",
      env: { JOBOPS_SKIP_PUBLIC_HEALTH_CHECK: "1" },
    });
    db.close();

    assert.equal(artifact.latestRun.available, false);
    assert.equal(artifact.latestRun.counts.truePortalSubmitted, 0);
    assert.deepEqual(artifact.latestRun.captcha, { available: false });
    assert.deepEqual(artifact.sourceDomainBlockerMatrix.latestRun, []);
    assert.deepEqual(artifact.sourceDomainBlockerMatrix.snapshotTotals, []);
    assert.equal(artifact.deltasSincePrevious.available, false);
    assert.equal(
      artifact.deltasSincePrevious.reason,
      "previous artifact not found",
    );
    assert.equal(Object.hasOwn(artifact.latestRun.captcha, "costUsd"), false);
  });

  it("resolves public health URL from explicit env, public base URL, then local fallback", () => {
    assert.deepEqual(
      resolvePublicHealthUrl({
        JOBOPS_AUTONOMOUS_PUBLIC_HEALTH_URL: "https://status.example/health",
      }),
      {
        url: "https://status.example/health",
        source: "env:JOBOPS_AUTONOMOUS_PUBLIC_HEALTH_URL",
      },
    );
    assert.deepEqual(
      resolvePublicHealthUrl({
        JOBOPS_PUBLIC_BASE_URL: "https://jobops.example/",
      }),
      {
        url: "https://jobops.example/health",
        source: "env:JOBOPS_PUBLIC_BASE_URL",
      },
    );
    assert.deepEqual(resolvePublicHealthUrl({ PORT: "3001" }), {
      url: "http://127.0.0.1:3001/health",
      source: "local:PORT",
    });
  });
});
