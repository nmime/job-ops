import { describe, expect, it } from "vitest";
import { formatEnvLine, getEnvVar, setEnvVar } from "./env-writer";

const SAMPLE = [
  "PORT=3005",
  "# freelance gates",
  'JOBOPS_FREELANCE_SEARCH_TERMS="typescript, node.js"',
  "JOBOPS_FREELANCE_FREELANCER_API_KEY=",
  "",
].join("\n");

describe("env-writer", () => {
  it("updates an existing key in place", () => {
    const r = setEnvVar(
      SAMPLE,
      "JOBOPS_FREELANCE_FREELANCER_API_KEY",
      "tok123",
    );
    expect(r.action).toBe("updated");
    expect(r.changed).toBe(true);
    const lines = r.text.split("\n");
    expect(lines[3]).toBe("JOBOPS_FREELANCE_FREELANCER_API_KEY=tok123");
    // Comments and other lines untouched.
    expect(lines[1]).toBe("# freelance gates");
    expect(lines[2]).toBe(
      'JOBOPS_FREELANCE_SEARCH_TERMS="typescript, node.js"',
    );
  });

  it("reports unchanged when value already matches", () => {
    const r = setEnvVar(SAMPLE, "PORT", "3005");
    expect(r).toEqual({ text: SAMPLE, changed: false, action: "unchanged" });
  });

  it("appends missing keys with a comment and keeps a trailing newline", () => {
    const r = setEnvVar(
      SAMPLE,
      "JOBOPS_FREELANCE_GURU_API_KEY",
      "g1",
      "Guru token",
    );
    expect(r.action).toBe("appended");
    const lines = r.text.split("\n");
    expect(lines[lines.length - 3]).toBe("# Guru token");
    expect(lines[lines.length - 2]).toBe("JOBOPS_FREELANCE_GURU_API_KEY=g1");
    expect(r.text.endsWith("\n")).toBe(true);
    expect(getEnvVar(r.text, "JOBOPS_FREELANCE_GURU_API_KEY")).toBe("g1");
  });

  it("quotes values with spaces or special chars", () => {
    expect(formatEnvLine("K", "plain")).toBe("K=plain");
    expect(formatEnvLine("K", "a b")).toBe('K="a b"');
    expect(formatEnvLine("K", "")).toBe('K=""');
    expect(formatEnvLine("K", 'say "hi"')).toBe('K="say \\"hi\\""');
  });

  it("getEnvVar unquotes and returns null for absent keys", () => {
    expect(getEnvVar(SAMPLE, "JOBOPS_FREELANCE_SEARCH_TERMS")).toBe(
      "typescript, node.js",
    );
    expect(getEnvVar(SAMPLE, "NOPE")).toBeNull();
    expect(getEnvVar(SAMPLE, "JOBOPS_FREELANCE_FREELANCER_API_KEY")).toBe("");
  });
});
