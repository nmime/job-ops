import { describe, expect, it } from "vitest";
import { FREELANCER_FLOW } from "./freelancer-flow";
import { PPH_FLOW } from "./pph-flow";
import { renderValue, runFlow, validateFlow } from "./runner";
import type { BrowserDriver } from "./types";

class FakeDriver implements BrowserDriver {
  calls: string[] = [];
  failAt?: string;
  async open(url: string) {
    this.calls.push(`open:${url}`);
  }
  async snapshot() {
    this.calls.push("snapshot");
    return "";
  }
  async fill(selector: string, value: string) {
    if (this.failAt === selector) throw new Error(`boom at ${selector}`);
    this.calls.push(`fill:${selector}:${value.length}`);
  }
  async click(selector: string) {
    this.calls.push(`click:${selector}`);
  }
  async check(selector: string) {
    this.calls.push(`check:${selector}`);
  }
  async eval(expression: string) {
    this.calls.push(`eval:${expression.slice(0, 20)}`);
    return "artifact-value";
  }
}

describe("runner", () => {
  it("renders secret placeholders and rejects unknown ones", () => {
    expect(renderValue("hi {{name}}", { name: "NMI" })).toBe("hi NMI");
    expect(() => renderValue("{{nope}}", {})).toThrow(/Missing secret: nope/);
    expect(renderValue(undefined, {})).toBe("");
  });

  it("validates the shipped freelancer flow", () => {
    const problems = validateFlow(FREELANCER_FLOW);
    expect(problems).toEqual([]);
  });

  it("validates the shipped peopleperhour flow", () => {
    const problems = validateFlow(PPH_FLOW);
    expect(problems).toEqual([]);
    expect(PPH_FLOW.credentialEnvVar).toBe(
      "JOBOPS_FREELANCE_PEOPLEPERHOUR_COOKIE",
    );
    expect(PPH_FLOW.steps.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        "open-signup",
        "add-skills",
        "add-language",
        "upload-profile-picture",
        "submit-application",
        "verify-email",
        "capture-session-cookie",
      ]),
    );
  });

  it("detects structural problems in bad flows", () => {
    const problems = validateFlow({
      platformId: "x",
      signupUrl: "http://insecure.example",
      credentialEnvVar: "WRONG_NAMESPACE",
      credentialFile: "x.txt",
      manualFollowUps: [],
      steps: [
        { id: "a", kind: "click", description: "" }, // missing selector
        { id: "a", kind: "open", description: "" }, // duplicate id, missing url
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "signupUrl must be https",
        "credentialEnvVar must be namespaced JOBOPS_FREELANCE_*",
        "duplicate step id: a",
        "step a needs a selector",
        "step a needs a url",
      ]),
    );
  });

  it("runs open/fill/click/extract steps and reports progress", async () => {
    const driver = new FakeDriver();
    const events: string[] = [];
    const result = await runFlow({
      flow: {
        platformId: "test",
        signupUrl: "https://x.example/signup",
        credentialEnvVar: "JOBOPS_FREELANCE_TEST_API_KEY",
        credentialFile: "test.txt",
        manualFollowUps: [],
        steps: [
          {
            id: "s1",
            kind: "open",
            url: "https://x.example/signup",
            description: "",
          },
          {
            id: "s2",
            kind: "fill",
            selector: 'textbox "Email"',
            value: "{{email}}",
            description: "",
          },
          { id: "s3", kind: "skip-if", condition: "manual", description: "" },
          {
            id: "s4",
            kind: "extract",
            selector: "location.href",
            artifact: "final-url",
            description: "",
          },
        ],
      },
      driver,
      credentialsBaseDir: "/tmp/unused",
      secrets: { email: "a@b.c" },
      onStep: (id, status) => events.push(`${id}:${status}`),
    });
    expect(result.ok).toBe(true);
    expect(result.completedSteps).toEqual(["s1", "s2", "s4"]);
    expect(result.artifacts["final-url"]).toBe("artifact-value");
    expect(driver.calls).toContain('fill:textbox "Email":5');
    expect(events).toContain("s3:skipped");
    expect(events).toContain("s4:done");
  });

  it("stops on failure and records the failed step", async () => {
    const driver = new FakeDriver();
    driver.failAt = 'textbox "Password"';
    const result = await runFlow({
      flow: {
        platformId: "test",
        signupUrl: "https://x.example/signup",
        credentialEnvVar: "JOBOPS_FREELANCE_TEST_API_KEY",
        credentialFile: "test.txt",
        manualFollowUps: [],
        steps: [
          { id: "ok", kind: "open", url: "https://x.example", description: "" },
          {
            id: "bad",
            kind: "fill",
            selector: 'textbox "Password"',
            value: "x",
            description: "",
          },
          {
            id: "never",
            kind: "open",
            url: "https://y.example",
            description: "",
          },
        ],
      },
      driver,
      credentialsBaseDir: "/tmp/unused",
      secrets: {},
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("bad");
    expect(result.completedSteps).toEqual(["ok"]);
    expect(driver.calls).not.toContain("open:https://y.example");
  });
});
