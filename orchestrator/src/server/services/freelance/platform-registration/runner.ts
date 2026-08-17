import type {
  RegistrationStep,
  RunContext,
  RunResult,
} from "./types";

/** Substitute {{secret}} placeholders using the context's secret bag. */
export function renderValue(
  template: string | undefined,
  secrets: Record<string, string>,
): string {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = secrets[name];
    if (v === undefined) throw new Error(`Missing secret: ${name}`);
    return v;
  });
}

function stepNeedsSecret(step: RegistrationStep): boolean {
  return step.value?.includes("{{") ?? false;
}

/**
 * Execute a registration flow against a browser driver.
 *
 * The runner is deliberately conservative: any step failure stops the run
 * (registration flows are stateful — continuing past a failed step usually
 * corrupts the account state). Progress is reported via ctx.onStep so an
 * operator can watch a long run.
 */
export async function runFlow(ctx: RunContext): Promise<RunResult> {
  const completed: string[] = [];
  const artifacts: Record<string, unknown> = {};

  for (const step of ctx.flow.steps) {
    ctx.onStep?.(step.id, "started");
    try {
      switch (step.kind) {
        case "open":
          if (step.url) await ctx.driver.open(step.url);
          break;
        case "fill": {
          const value = renderValue(step.value, ctx.secrets);
          if (step.selector) await ctx.driver.fill(step.selector, value);
          break;
        }
        case "click":
          if (step.selector) await ctx.driver.click(step.selector);
          break;
        case "check":
          if (step.selector) await ctx.driver.check(step.selector);
          break;
        case "wait":
          await new Promise((r) => setTimeout(r, step.ms ?? 0));
          break;
        case "extract": {
          const value = await ctx.driver.eval(step.selector ?? "");
          artifacts[step.artifact ?? step.id] = value;
          break;
        }
        case "skip-if":
          // Conditions are operator/driver knowledge; the runner records the
          // skip and leaves execution to the operator (manual follow-up).
          ctx.onStep?.(step.id, "skipped", step.condition);
          continue;
      }
      completed.push(step.id);
      ctx.onStep?.(step.id, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.onStep?.(step.id, "failed", message);
      return {
        ok: false,
        completedSteps: completed,
        failedStep: step.id,
        error: message,
        artifacts,
      };
    }
  }

  return { ok: true, completedSteps: completed, artifacts };
}

/** Validate a flow spec before running (cheap structural checks). */
export function validateFlow(flow: RunContext["flow"]): string[] {
  const problems: string[] = [];
  if (!flow.signupUrl.startsWith("https://")) {
    problems.push("signupUrl must be https");
  }
  if (!flow.credentialEnvVar.startsWith("JOBOPS_FREELANCE_")) {
    problems.push("credentialEnvVar must be namespaced JOBOPS_FREELANCE_*");
  }
  const ids = new Set<string>();
  for (const step of flow.steps) {
    if (ids.has(step.id)) problems.push(`duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (
      (step.kind === "fill" ||
        step.kind === "click" ||
        step.kind === "check") &&
      !step.selector
    ) {
      problems.push(`step ${step.id} needs a selector`);
    }
    if (step.kind === "open" && !step.url) {
      problems.push(`step ${step.id} needs a url`);
    }
    if (stepNeedsSecret(step)) {
      // Secrets are supplied at run time; nothing to check statically.
    }
  }
  return problems;
}
