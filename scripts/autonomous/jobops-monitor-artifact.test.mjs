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
