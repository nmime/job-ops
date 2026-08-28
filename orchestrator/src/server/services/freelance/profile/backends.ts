/**
 * Profile-campaign backends (docs/freelance-profile-campaign.md).
 *
 *   api             spawn the idempotent orchestrator/scripts/profile-fill
 *                   scripts (plain fetch, session cookie; read-diff-write,
 *                   re-read to verify) and record the result + evidence.
 *   browser_mac     persist a `pending` step list in
 *                   freelance_profile_actions; the Mac operator applies it
 *                   and POSTs results back via .../record.
 *   browser_sandbox Playwright + cookies for platforms not IP-blocked from
 *                   the datacenter. Degrades honestly (falls back to queued
 *                   mac steps) when Playwright is not installed.
 *   none            not-applicable.
 *
 * Verification rule: `done` is returned only for a confirmed re-read;
 * everything else is `pending` (queued) or `error` (honest gate/failure).
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getDataDir } from "../../../config/dataDir";
import {
  getProfilePlatform,
  type ProfileActionDef,
  type ProfileBackend,
  type ProfilePlatformSpec,
} from "./platforms";
import {
  getMergedProfile,
  getPendingAction,
  recordProfileAction,
  upsertProfile,
  verifyField,
} from "./state";

const requireModule = createRequire(import.meta.url);

export type ProfileActionKind = "complete" | "post" | "publish" | "promote";

export type ProfileActionStatus =
  | "done"
  | "pending"
  | "error"
  | "user_only"
  | "not-applicable";

export interface ProfileActionResult {
  platform: string;
  kind: ProfileActionKind;
  backend: ProfileBackend;
  status: ProfileActionStatus;
  /** True only when the outcome was confirmed by a re-read. */
  verified: boolean;
  notes: string[];
  evidence?: unknown;
  /** Action row id (pending mac step list / attempt record). */
  actionId?: number;
}

// --- Helpers ---------------------------------------------------------------------

function repoRoot(): string {
  // data dir = <repo>/data (DATA_DIR override respected)
  return dirname(getDataDir());
}

function parseScriptJson(stdout: string): Record<string, any> | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Run one profile-fill script and parse its strict-JSON stdout. */
export function runFillScript(
  scriptRelPath: string,
  timeoutMs = 180_000,
): Promise<{ ok: boolean; json: Record<string, any> | null; error?: string }> {
  const scriptPath = join(repoRoot(), scriptRelPath);
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--no", "tsx", scriptPath],
      { cwd: repoRoot(), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const json = parseScriptJson(String(stdout ?? ""));
        if (json) {
          resolve({ ok: true, json });
        } else {
          resolve({
            ok: false,
            json: null,
            error:
              (error as Error | null)?.message ??
              (String(stderr ?? "").slice(0, 500) || "no JSON output"),
          });
        }
      },
    );
  });
}

function playwrightAvailable(): boolean {
  try {
    requireModule.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

// --- Step lists for the operator backends ------------------------------------------

/**
 * Build the operator step list for `complete` from the current field state:
 * every non-user_only field that is not yet done becomes a step.
 */
function fillStepsFor(spec: ProfilePlatformSpec): string[] {
  const merged = getMergedProfile(spec.id);
  const steps: string[] = [];
  for (const f of spec.fields) {
    const state = merged?.fields[f.name];
    if (f.userOnly) continue;
    if (state && state.status === "done") continue;
    const gate = state?.status === "blocked" ? " (currently blocked — resolve the gate first)" : "";
    steps.push(`Fill ${f.label} (${f.name}) via ${f.method}${gate}`);
  }
  steps.push(
    `Re-read the profile page after saving and confirm the values${
      merged?.pendingSteps.length ? "" : ""
    }`,
  );
  return steps;
}

function actionStepsFor(def: ProfileActionDef): string[] {
  return def.steps;
}

/**
 * Queue (or reuse) the pending operator step list for a platform+kind.
 * Idempotent: a pending action for the same (platform, kind) is reused, so
 * re-runs never duplicate the step list.
 */
function queueMacSteps(
  spec: ProfilePlatformSpec,
  kind: "fill" | "post" | "publish" | "promote",
  steps: string[],
  target: string,
): { actionId: number; created: boolean } {
  const existing = getPendingAction(spec.id, kind);
  if (existing) return { actionId: existing.id, created: false };
  const action = recordProfileAction({
    platform: spec.id,
    kind,
    target,
    payload: steps,
    status: "pending",
  });
  return { actionId: action.id, created: true };
}

// --- api backend ---------------------------------------------------------------------

async function runApiFill(spec: ProfilePlatformSpec): Promise<ProfileActionResult> {
  if (!spec.apiScript) {
    return {
      platform: spec.id,
      kind: "complete",
      backend: "api",
      status: "error",
      verified: false,
      notes: [`no fill script registered for ${spec.id} (api backend)`],
    };
  }

  const { ok, json, error } = await runFillScript(spec.apiScript);
  if (!ok || !json) {
    const action = recordProfileAction({
      platform: spec.id,
      kind: "fill",
      target: spec.apiScript,
      status: "error",
      evidence: { error },
    });
    return {
      platform: spec.id,
      kind: "complete",
      backend: "api",
      status: "error",
      verified: false,
      notes: [`fill script failed: ${error ?? "unknown error"}`],
      evidence: { error },
      actionId: action.id,
    };
  }

  const notes: string[] = [...(json.notes ?? [])];
  const verified = json.verified === true;
  const evidence: Record<string, unknown> = {
    filled: json.filled ?? false,
    verified,
    scriptEvidence: json.evidence ?? null,
    apiPossible: json.apiPossible ?? true,
  };

  if (spec.apiScriptKind === "probe") {
    // Session probe only (e.g. contra): report the session state honestly and
    // leave the actual writes to the operator backend.
    const sessionValid = json.evidence?.sessionValid === true;
    const action = recordProfileAction({
      platform: spec.id,
      kind: "fill",
      target: spec.apiScript,
      status: sessionValid ? "done" : "error",
      evidence: { ...evidence, sessionValid, notes },
    });
    return {
      platform: spec.id,
      kind: "complete",
      backend: spec.backend,
      status: sessionValid ? "pending" : "error",
      verified: false,
      notes: [
        sessionValid
          ? "session probe: valid — profile writes can proceed via the browser operator"
          : "gated: the session probe reports the captured session is not valid — a fresh login + cookie re-capture is required before browser writes",
        ...notes,
      ],
      evidence,
      actionId: action.id,
    };
  }

  if (verified) {
    // Confirmed re-read: mark the api-covered fields done with evidence.
    const evidenceText = JSON.stringify(json.evidence ?? {}).slice(0, 800);
    for (const field of spec.apiCoversFields ?? []) {
      verifyField(spec.id, field, `api re-read verified: ${evidenceText}`);
    }
    const action = recordProfileAction({
      platform: spec.id,
      kind: "fill",
      target: spec.apiScript,
      status: "done",
      evidence: { ...evidence, notes },
    });
    // If every non-user-only field is now done, the profile is complete.
    const merged = getMergedProfile(spec.id);
    if (merged) {
      const open = Object.entries(merged.fields).filter(
        ([, f]) => f.status !== "done" && f.status !== "user_only",
      );
      if (open.length === 0) {
        upsertProfile(spec.id, { status: "complete" });
        notes.push("all non-user_only fields done — profile marked complete");
      }
    }
    return {
      platform: spec.id,
      kind: "complete",
      backend: "api",
      status: "done",
      verified: true,
      notes,
      evidence,
      actionId: action.id,
    };
  }

  // Not verified (gate, CF block, session expired, ...): record honestly.
  const action = recordProfileAction({
    platform: spec.id,
    kind: "fill",
    target: spec.apiScript,
    status: "error",
    evidence: { ...evidence, notes },
  });
  return {
    platform: spec.id,
    kind: "complete",
    backend: "api",
    status: "error",
    verified: false,
    notes: [
      "fill ran but the re-read did not confirm the target state (see evidence/notes for the precise gate)",
      ...notes,
    ],
    evidence,
    actionId: action.id,
  };
}

// --- browser_sandbox backend -----------------------------------------------------------

async function runBrowserSandbox(
  spec: ProfilePlatformSpec,
  kind: ProfileActionKind,
  steps: string[],
  target: string,
): Promise<ProfileActionResult> {
  const stepKind = kind === "complete" ? "fill" : kind;
  if (!playwrightAvailable()) {
    // Honest degradation: Playwright is not installed in this environment.
    // Queue the operator (mac) fallback so nothing is lost.
    const queued = queueMacSteps(spec, stepKind, steps, target);
    return {
      platform: spec.id,
      kind,
      backend: "browser_sandbox",
      status: "pending",
      verified: false,
      notes: [
        "playwright is not installed in this environment — the step list was queued for the browser_mac operator instead",
        `pending action #${queued.actionId} (${queued.created ? "created" : "reused"})`,
      ],
      actionId: queued.actionId,
    };
  }
  // Playwright present: the flow is cookie + navigate + fill + re-read.
  // Kept minimal and guarded — today no campaign platform depends on it
  // being implemented end-to-end (malt's cookie works, browsers are the
  // future path once Playwright is added as a dependency).
  const queued = queueMacSteps(spec, stepKind, steps, target);
  return {
    platform: spec.id,
    kind,
    backend: "browser_sandbox",
    status: "pending",
    verified: false,
    notes: [
      "playwright is installed but the sandbox browser flow is not yet implemented for this platform — step list queued for the operator",
      `pending action #${queued.actionId}`,
    ],
    actionId: queued.actionId,
  };
}

// --- Dispatch -----------------------------------------------------------------------------

/**
 * Run one campaign action for one platform through its backend.
 * Never throws for known platforms — errors are returned as results.
 */
export async function runProfileAction(
  platformId: string,
  kind: ProfileActionKind,
): Promise<ProfileActionResult> {
  const spec = getProfilePlatform(platformId);
  if (!spec) {
    throw new Error(`unknown profile platform: ${platformId}`);
  }

  if (spec.backend === "none") {
    return {
      platform: spec.id,
      kind,
      backend: "none",
      status: "not-applicable",
      verified: false,
      notes: [
        ...(spec.notes ?? []).filter((n) => n.toLowerCase().includes("not-applicable")),
      ],
    };
  }

  if (kind === "complete") {
    switch (spec.backend) {
      case "api":
        return runApiFill(spec);
      case "browser_sandbox":
        return runBrowserSandbox(spec, "complete", fillStepsFor(spec), "profile fill");
      case "browser_mac":
        if (spec.apiScript && spec.apiScriptKind === "probe") {
          // Verify the session state first (contra), then queue the steps.
          const probe = await runApiFill(spec);
          const steps = fillStepsFor(spec);
          const queued = queueMacSteps(spec, "fill", steps, "profile fill");
          return {
            platform: spec.id,
            kind: "complete",
            backend: "browser_mac",
            status: probe.status === "error" ? "error" : "pending",
            verified: false,
            notes: [
              ...probe.notes,
              `pending operator step list: action #${queued.actionId} (${queued.created ? "created" : "reused"})`,
            ],
            evidence: probe.evidence,
            actionId: queued.actionId,
          };
        }
        const steps = fillStepsFor(spec);
        const queued = queueMacSteps(spec, "fill", steps, "profile fill");
        return {
          platform: spec.id,
          kind: "complete",
          backend: "browser_mac",
          status: "pending",
          verified: false,
          notes: [
            `operator step list queued: action #${queued.actionId} (${queued.created ? "created" : "reused"})`,
          ],
          actionId: queued.actionId,
        };
      default:
        return {
          platform: spec.id,
          kind,
          backend: spec.backend,
          status: "error",
          verified: false,
          notes: [`unsupported backend: ${spec.backend}`],
        };
    }
  }

  // post / publish / promote — definitions from the platform registry.
  const def = spec.actions[kind as "post" | "publish" | "promote"];
  if (!def || !def.applicable) {
    return {
      platform: spec.id,
      kind,
      backend: spec.backend,
      status: "not-applicable",
      verified: false,
      notes: [def?.reason ?? `${kind} is not defined for ${spec.id}`],
    };
  }

  const steps = actionStepsFor(def);
  const target = def.description;

  switch (spec.backend) {
    case "api":
      // No api implementations for post/publish/promote today — the action
      // definitions are operator steps; queue them honestly.
      const queued = queueMacSteps(spec, kind as "post" | "publish" | "promote", steps, target);
      return {
        platform: spec.id,
        kind,
        backend: "api",
        status: "pending",
        verified: false,
        notes: [
          `${spec.id}: ${kind} has no API implementation — operator step list queued (action #${queued.actionId})`,
        ],
        actionId: queued.actionId,
      };
    case "browser_sandbox":
      return runBrowserSandbox(spec, kind, steps, target);
    case "browser_mac": {
      const queued = queueMacSteps(spec, kind as "post" | "publish" | "promote", steps, target);
      return {
        platform: spec.id,
        kind,
        backend: "browser_mac",
        status: "pending",
        verified: false,
        notes: [
          `operator step list queued: action #${queued.actionId} (${queued.created ? "created" : "reused"})`,
        ],
        actionId: queued.actionId,
      };
    }
    default:
      return {
        platform: spec.id,
        kind,
        backend: spec.backend,
        status: "not-applicable",
        verified: false,
        notes: [`no backend for ${kind} on ${spec.id}`],
      };
  }
}
