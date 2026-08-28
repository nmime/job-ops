/**
 * Freelance credential store.
 *
 * Two credential sources, in priority order:
 *   1. process.env (JOBOPS_FREELANCE_<PLATFORM>_* variables, or .env)
 *   2. credential files: <DATA_DIR>/.credentials/<platform>.txt — one line,
 *      the platform's PRIMARY credential (usually the session Cookie header).
 *
 * Security rules:
 *   - the .credentials directory is created 0700 (owner-only; a 0600 mode on
 *     a directory would make it unusable because directory traversal needs
 *     the execute bit) and private to the owning user;
 *   - credential VALUES are never logged — this module has no logger calls.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@server/config/dataDir";
import type { FreelancePlatformId } from "@shared/types/freelance";

export type FreelanceCredentialFormat =
  | "cookie"
  | "cookie+apikey"
  | "apikey"
  | "webhook-token"
  | "none";

/** How the platform's apply adapter actually works (audit of all 18). */
export type FreelanceApplyKind =
  | "real-browser"
  | "real-api"
  | "network-application"
  | "none";

/** The audit's raw `apply` field for a platform. */
export type FreelanceAuditApply =
  | "real-api"
  | "real-browser"
  | "partial"
  | "stub"
  | "not-applicable"
  | "missing";

export interface FreelanceCredentialTableEntry {
  displayName: string;
  /**
   * Every credential env var the adapter reads, in priority order. The first
   * entry is the PRIMARY credential — the one a single-line credential file
   * applies to (usually the session Cookie header).
   */
  envVars: string[];
  format: FreelanceCredentialFormat;
  /** Audit's `apply` field; "not-applicable"/"missing" = no per-gig apply. */
  apply: FreelanceAuditApply;
  applyKind: FreelanceApplyKind;
}

const P = "JOBOPS_FREELANCE";

/**
 * Hard-coded credential table, derived from /home/daytona/adapters-audit.json
 * and the adapters' resolveCredential implementations (each reads
 * `${prefix}_API_KEY` / `${prefix}_COOKIE` from ctx.settings ?? process.env).
 */
export const FREELANCE_CREDENTIAL_TABLE: Record<
  FreelancePlatformId,
  FreelanceCredentialTableEntry
> = {
  upwork: {
    displayName: "Upwork",
    envVars: [`${P}_UPWORK_API_KEY`, `${P}_UPWORK_COOKIE`],
    format: "cookie+apikey",
    apply: "real-api",
    applyKind: "real-api",
  },
  freelancer: {
    displayName: "Freelancer.com",
    envVars: [`${P}_FREELANCER_API_KEY`, "FREELANCER_API_KEY"],
    format: "apikey",
    apply: "real-api",
    applyKind: "real-api",
  },
  fiverr: {
    displayName: "Fiverr",
    envVars: [`${P}_FIVERR_COOKIE`, `${P}_FIVERR_API_KEY`],
    format: "cookie",
    apply: "real-browser",
    applyKind: "real-browser",
  },
  toptal: {
    displayName: "Toptal",
    envVars: [`${P}_TOPTAL_COOKIE`, `${P}_TOPTAL_API_KEY`],
    format: "cookie",
    apply: "partial",
    applyKind: "real-browser",
  },
  peopleperhour: {
    displayName: "PeoplePerHour",
    envVars: [`${P}_PEOPLEPERHOUR_COOKIE`, `${P}_PEOPLEPERHOUR_API_KEY`],
    format: "cookie",
    apply: "real-browser",
    applyKind: "real-browser",
  },
  guru: {
    displayName: "Guru",
    envVars: [`${P}_GURU_COOKIE`, `${P}_GURU_API_KEY`],
    format: "cookie+apikey",
    apply: "real-browser",
    applyKind: "real-browser",
  },
  remoteok: {
    displayName: "RemoteOK",
    envVars: [],
    format: "none",
    apply: "missing",
    applyKind: "none",
  },
  weworkremotely: {
    displayName: "We Work Remotely",
    envVars: [],
    format: "none",
    apply: "missing",
    applyKind: "none",
  },
  malt: {
    displayName: "Malt",
    envVars: [`${P}_MALT_COOKIE`],
    format: "cookie",
    apply: "partial",
    applyKind: "real-browser",
  },
  freelancermap: {
    displayName: "freelancermap (DE)",
    envVars: [`${P}_FREELANCERMAP_API_KEY`],
    format: "apikey",
    apply: "real-api",
    applyKind: "real-api",
  },
  wellfound: {
    displayName: "Wellfound (AngelList)",
    envVars: [`${P}_WELLFOUND_COOKIE`, `${P}_WELLFOUND_API_KEY`],
    format: "cookie+apikey",
    apply: "real-browser",
    applyKind: "real-browser",
  },
  braintrust: {
    displayName: "Braintrust",
    envVars: [`${P}_BRAINTRUST_COOKIE`, `${P}_BRAINTRUST_API_KEY`],
    format: "cookie",
    apply: "stub",
    applyKind: "network-application",
  },
  contra: {
    displayName: "Contra",
    envVars: [`${P}_CONTRA_COOKIE`],
    format: "cookie",
    apply: "partial",
    applyKind: "real-browser",
  },
  "arc-dev": {
    displayName: "Arc.dev",
    envVars: [`${P}_ARC_DEV_COOKIE`, `${P}_ARC_DEV_API_KEY`],
    format: "cookie",
    apply: "real-browser",
    applyKind: "real-browser",
  },
  "gun-io": {
    displayName: "Gun.io",
    envVars: [`${P}_GUN_IO_API_KEY`, `${P}_GUN_IO_COOKIE`],
    format: "cookie+apikey",
    apply: "not-applicable",
    applyKind: "network-application",
  },
  turing: {
    displayName: "Turing",
    envVars: [`${P}_TURING_API_KEY`, `${P}_TURING_COOKIE`],
    format: "cookie+apikey",
    apply: "stub",
    applyKind: "network-application",
  },
  flexjobs: {
    displayName: "FlexJobs",
    envVars: [`${P}_FLEXJOBS_COOKIE`, `${P}_FLEXJOBS_API_KEY`],
    format: "cookie",
    apply: "real-browser",
    applyKind: "real-browser",
  },
  wantapply: {
    displayName: "Wantapply",
    envVars: [`${P}_WANTAPPLY_WEBHOOK_URL`],
    format: "webhook-token",
    apply: "not-applicable",
    applyKind: "none",
  },
  "aggregator-core": {
    displayName: "Freelance Aggregator Engine",
    envVars: [],
    format: "none",
    apply: "not-applicable",
    applyKind: "none",
  },
};

/**
 * The credential file directory: <DATA_DIR>/.credentials.
 *
 * Computed once at module load (getDataDir() is stable per process). The
 * functions below call `credentialFilesDir()` so tests that swap DATA_DIR
 * after import still observe the right location.
 */
export const CREDENTIAL_FILES_DIR = join(getDataDir(), ".credentials");

export function credentialFilesDir(): string {
  return join(getDataDir(), ".credentials");
}

let ensuredDir: string | null = null;

/** Create the credential dir on first use and lock it to the owner (0700). */
function ensureCredentialDir(): void {
  const dir = credentialFilesDir();
  if (ensuredDir === dir) return;
  ensuredDir = dir;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  try {
    // Owner-only. (Spec asked for 0600, but a directory without the execute
    // bit cannot be traversed even by its owner — 0700 is the usable
    // owner-private mode.)
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

/**
 * Read <dir>/<platform>.txt and return the first non-empty, non-comment
 * (#) line, trimmed. Returns null when the file is absent or has no value.
 * Never throws, never logs the value.
 */
export function loadCredentialFile(platform: string): string | null {
  try {
    ensureCredentialDir();
    const filePath = join(credentialFilesDir(), `${platform}.txt`);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve every credential env var of a platform.
 *
 * process.env wins per variable; when a variable is unset, the credential
 * file (if present) fills the PRIMARY variable (first in the table — the
 * session cookie for cookie platforms). Only variables with a value are
 * included in the result. Values are never logged.
 */
export function resolvePlatformCredentials(
  platform: FreelancePlatformId,
): Record<string, string> {
  const entry = FREELANCE_CREDENTIAL_TABLE[platform];
  const out: Record<string, string> = {};
  if (!entry || entry.envVars.length === 0) return out;

  const fileValue = loadCredentialFile(platform);
  // The file holds the session Cookie header: apply it to the platform's
  // _COOKIE variable when one exists, otherwise to the first variable.
  const cookieIdx = entry.envVars.findIndex((n) => n.endsWith("_COOKIE"));
  const fileIdx = cookieIdx >= 0 ? cookieIdx : 0;
  for (let i = 0; i < entry.envVars.length; i += 1) {
    const name = entry.envVars[i];
    const envValue = (process.env[name] ?? "").trim();
    if (envValue) {
      out[name] = envValue;
      continue;
    }
    if (i === fileIdx && fileValue) {
      out[name] = fileValue;
    }
  }
  return out;
}

/**
 * Seed process.env from credential files, for variables that are unset or
 * empty. Called once at process start (server + CLI) so adapters that read
 * plain env see the file-backed values. Real env always wins. Never logs.
 */
export function seedCredentialEnv(): void {
  for (const platform of Object.keys(FREELANCE_CREDENTIAL_TABLE) as FreelancePlatformId[]) {
    const resolved = resolvePlatformCredentials(platform);
    for (const name of Object.keys(resolved)) {
      const current = (process.env[name] ?? "").trim();
      if (!current) {
        try {
          process.env[name] = resolved[name];
        } catch {
          // non-configurable env in some runtimes; adapters fall back to files
        }
      }
    }
  }
}

export interface FreelanceCredentialStatus {
  /** All credential env vars the adapter reads (priority order). */
  envVars: string[];
  format: FreelanceCredentialFormat;
  /** Subset of envVars currently set (env or credential file). */
  present: string[];
  /** Subset of envVars not set anywhere. */
  missing: string[];
  /** True when no credential is required, or at least one is present. */
  configured: boolean;
}

/** Presence status (never values) of a platform's credentials. */
export function credentialStatus(
  platform: FreelancePlatformId,
): FreelanceCredentialStatus {
  const entry = FREELANCE_CREDENTIAL_TABLE[platform] ?? {
    envVars: [],
    format: "none",
  };
  const resolved = resolvePlatformCredentials(platform);
  const present = entry.envVars.filter((name) => resolved[name] !== undefined);
  const missing = entry.envVars.filter((name) => resolved[name] === undefined);
  return {
    envVars: entry.envVars,
    format: entry.format,
    present,
    missing,
    configured: entry.format === "none" || present.length > 0,
  };
}

/** True when the platform needs a credential and none is configured. */
export function isCredentialMissing(platform: FreelancePlatformId): boolean {
  const status = credentialStatus(platform);
  return status.format !== "none" && status.present.length === 0;
}

/**
 * Status-level (no network, no browser) verdict for GET /adapters:
 * "not-applicable" for platforms with no per-gig apply, "blocked" when the
 * required credential is missing, otherwise "verified" at status level.
 */
export function statusVerdict(
  platform: FreelancePlatformId,
): "verified" | "blocked" | "not-applicable" {
  const entry = FREELANCE_CREDENTIAL_TABLE[platform];
  if (
    entry &&
    (entry.apply === "not-applicable" || entry.apply === "missing")
  ) {
    return "not-applicable";
  }
  return isCredentialMissing(platform) ? "blocked" : "verified";
}
