import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FreelancePlatformId } from "@shared/types/freelance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialFilesDir,
  credentialStatus,
  FREELANCE_CREDENTIAL_TABLE,
  isCredentialMissing,
  loadCredentialFile,
  resolvePlatformCredentials,
  statusVerdict,
} from "./credentials";

const CONTRA_COOKIE = "JOBOPS_FREELANCE_CONTRA_COOKIE";
const UPWORK_API_KEY = "JOBOPS_FREELANCE_UPWORK_API_KEY";
const UPWORK_COOKIE = "JOBOPS_FREELANCE_UPWORK_COOKIE";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "job-ops-credentials-"));
  process.env.DATA_DIR = tempDir;
  // Seed the credential directory (created 0700 on first use).
  loadCredentialFile("seed");
  delete process.env[CONTRA_COOKIE];
  delete process.env[UPWORK_API_KEY];
  delete process.env[UPWORK_COOKIE];
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env[CONTRA_COOKIE];
  delete process.env[UPWORK_API_KEY];
  delete process.env[UPWORK_COOKIE];
});

describe("loadCredentialFile", () => {
  it("returns null when the file does not exist", () => {
    expect(loadCredentialFile("contra")).toBeNull();
  });

  it("reads the first non-comment line, trimmed", async () => {
    await writeFile(
      join(credentialFilesDir(), "contra.txt"),
      "# copy this full Cookie header here\n\n  a=1; b=2; session=abc  \nsecond=ignored\n",
      "utf8",
    );
    expect(loadCredentialFile("contra")).toBe("a=1; b=2; session=abc");
  });

  it("returns null for a comment/blank-only file", async () => {
    await writeFile(
      join(credentialFilesDir(), "contra.txt"),
      "# only comments\n\n",
      "utf8",
    );
    expect(loadCredentialFile("contra")).toBeNull();
  });

  it("creates the credential directory owner-only (0700) on first use", async () => {
    expect(credentialFilesDir()).toBe(join(tempDir, ".credentials"));
    loadCredentialFile("contra");
    const st = await stat(credentialFilesDir());
    expect(st.mode & 0o777).toBe(0o700);
  });
});

describe("resolvePlatformCredentials", () => {
  it("returns {} for platforms that need no credential", () => {
    expect(resolvePlatformCredentials("remoteok")).toEqual({});
  });

  it("reads process.env for each credential var", () => {
    process.env[CONTRA_COOKIE] = "env-cookie";
    expect(resolvePlatformCredentials("contra")).toEqual({
      [CONTRA_COOKIE]: "env-cookie",
    });
  });

  it("fills the PRIMARY var from the credential file when env is unset", async () => {
    await writeFile(
      join(credentialFilesDir(), "contra.txt"),
      "file-cookie",
      "utf8",
    );
    expect(resolvePlatformCredentials("contra")).toEqual({
      [CONTRA_COOKIE]: "file-cookie",
    });
  });

  it("env wins over the file; the file never fills secondary vars", async () => {
    await writeFile(
      join(credentialFilesDir(), "upwork.txt"),
      "file-primary",
      "utf8",
    );
    process.env[UPWORK_COOKIE] = "env-cookie";
    expect(resolvePlatformCredentials("upwork")).toEqual({
      [UPWORK_API_KEY]: "file-primary",
      [UPWORK_COOKIE]: "env-cookie",
    });
    // env present on the primary var → file ignored for it
    process.env[UPWORK_API_KEY] = "env-key";
    expect(resolvePlatformCredentials("upwork")).toEqual({
      [UPWORK_API_KEY]: "env-key",
      [UPWORK_COOKIE]: "env-cookie",
    });
  });
});

describe("credentialStatus / isCredentialMissing", () => {
  it("boards need no credential and are configured by default", () => {
    const status = credentialStatus("remoteok");
    expect(status.envVars).toEqual([]);
    expect(status.format).toBe("none");
    expect(status.configured).toBe(true);
    expect(isCredentialMissing("remoteok")).toBe(false);
  });

  it("marks missing env vars for cookie platforms", () => {
    const status = credentialStatus("contra");
    expect(status.envVars).toEqual([CONTRA_COOKIE]);
    expect(status.present).toEqual([]);
    expect(status.missing).toEqual([CONTRA_COOKIE]);
    expect(status.configured).toBe(false);
    expect(isCredentialMissing("contra")).toBe(true);
  });

  it("counts a credential-file value as present", async () => {
    await writeFile(
      join(credentialFilesDir(), "contra.txt"),
      "file-cookie",
      "utf8",
    );
    const status = credentialStatus("contra");
    expect(status.present).toEqual([CONTRA_COOKIE]);
    expect(status.missing).toEqual([]);
    expect(status.configured).toBe(true);
    expect(isCredentialMissing("contra")).toBe(false);
  });
});

describe("statusVerdict", () => {
  it("is not-applicable for platforms without per-gig apply", () => {
    expect(statusVerdict("remoteok")).toBe("not-applicable");
    expect(statusVerdict("wantapply")).toBe("not-applicable");
    expect(statusVerdict("gun-io")).toBe("not-applicable");
  });

  it("is blocked when the credential is missing and verified otherwise", () => {
    expect(statusVerdict("contra")).toBe("blocked");
    process.env[CONTRA_COOKIE] = "x";
    expect(statusVerdict("contra")).toBe("verified");
  });
});

describe("FREELANCE_CREDENTIAL_TABLE", () => {
  it("covers all 18 real platforms with a valid shape", () => {
    const ids = Object.keys(FREELANCE_CREDENTIAL_TABLE);
    expect(ids).toContain("aggregator-core");
    for (const platform of [
      "contra",
      "upwork",
      "fiverr",
      "freelancer",
      "peopleperhour",
      "guru",
      "toptal",
      "turing",
      "gun-io",
      "braintrust",
      "malt",
      "wantapply",
      "remoteok",
      "weworkremotely",
      "wellfound",
      "arc-dev",
      "freelancermap",
      "flexjobs",
    ]) {
      const entry = FREELANCE_CREDENTIAL_TABLE[platform as FreelancePlatformId];
      expect(entry, `table entry for ${platform}`).toBeDefined();
      expect(entry.envVars.length).toBeGreaterThan(
        entry.format === "none" ? -1 : 0,
      );
      expect([
        "cookie",
        "cookie+apikey",
        "apikey",
        "webhook-token",
        "none",
      ]).toContain(entry.format);
      expect([
        "real-browser",
        "real-api",
        "network-application",
        "none",
      ]).toContain(entry.applyKind);
    }
  });
});
