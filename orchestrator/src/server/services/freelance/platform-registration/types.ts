/**
 * Platform registration module — shared types.
 *
 * The module splits registration work into three layers:
 *  1. A declarative FLOW SPEC (what to do, in which order) — data, auditable.
 *  2. A BROWSER DRIVER interface (how to do it) — swappable, testable with fakes.
 *  3. PURE helpers (credential storage, .env rewriting, email link parsing).
 */

export type RegistrationStepKind =
  | "open"
  | "fill"
  | "click"
  | "check"
  | "wait"
  | "extract"
  | "skip-if";

export interface RegistrationStep {
  id: string;
  kind: RegistrationStepKind;
  description: string;
  /** URL for kind "open". */
  url?: string;
  /** Accessibility ref selector for fill/click/check (resolved at run time). */
  selector?: string;
  value?: string;
  ms?: number;
  /** For extract: name of the captured artifact. */
  artifact?: string;
  /** Human-readable condition for skip-if steps (evaluated by driver). */
  condition?: string;
}

export interface PlatformRegistrationFlow {
  platformId: string;
  /** Canonical signup entry point. */
  signupUrl: string;
  steps: RegistrationStep[];
  /** Env var that receives the final credential (e.g. JOBOPS_FREELANCE_FREELANCER_API_KEY). */
  credentialEnvVar: string;
  /** File inside <DATA_DIR>/.credentials/ holding the raw credential material. */
  credentialFile: string;
  /** What the operator must still do by hand (e.g. payment verification). */
  manualFollowUps: string[];
}

export interface BrowserDriver {
  open(url: string): Promise<void>;
  snapshot(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  check(selector: string): Promise<void>;
  eval(expression: string): Promise<unknown>;
}

export interface RunContext {
  flow: PlatformRegistrationFlow;
  driver: BrowserDriver;
  credentialsBaseDir: string;
  /** Secrets injected per step (e.g. password) — never logged. */
  secrets: Record<string, string>;
  /** Structured progress sink. */
  onStep?: (
    step: string,
    status: "started" | "done" | "skipped" | "failed",
    detail?: string,
  ) => void;
}

export interface RunResult {
  ok: boolean;
  completedSteps: string[];
  failedStep?: string;
  error?: string;
  artifacts: Record<string, unknown>;
}
