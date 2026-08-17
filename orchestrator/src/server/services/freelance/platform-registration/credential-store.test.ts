import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  credentialFilePath,
  maskSecret,
  parseCredentialText,
  readCredential,
  serializeCredential,
  updateCredential,
  writeCredential,
} from "./credential-store";

describe("credential-store", () => {
  it("round-trips fields through serialize/parse", () => {
    const text = serializeCredential({
      email: "a-bad8eb76@agents.splox.io",
      password: "xK9mQ2vLpR!x9",
      username: "nmime",
    });
    const parsed = parseCredentialText("freelancer", text);
    expect(parsed.fields).toEqual({
      email: "a-bad8eb76@agents.splox.io",
      password: "xK9mQ2vLpR!x9",
      username: "nmime",
    });
  });

  it("ignores comments, blanks and malformed lines", () => {
    const parsed = parseCredentialText(
      "x",
      "# comment\n\nemail: a@b.c\nnot a line\npw: z",
    );
    expect(parsed.fields).toEqual({ email: "a@b.c", pw: "z" });
  });

  it("writes files with 0600 mode under .credentials/", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cred-"));
    const file = writeCredential(dir, "freelancer", { email: "a@b.c" });
    expect(file).toBe(credentialFilePath(dir, "freelancer"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("email: a@b.c");
  });

  it("readCredential returns null when absent and reads back written data", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cred-"));
    expect(readCredential(dir, "freelancer")).toBeNull();
    writeCredential(dir, "freelancer", { email: "a@b.c", token: "abc" });
    const got = readCredential(dir, "freelancer");
    expect(got?.fields).toEqual({ email: "a@b.c", token: "abc" });
  });

  it("updateCredential merges without clobbering other fields", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cred-"));
    writeCredential(dir, "freelancer", { email: "a@b.c", password: "old" });
    updateCredential(dir, "freelancer", { password: "new" });
    const got = readCredential(dir, "freelancer");
    expect(got?.fields).toEqual({ email: "a@b.c", password: "new" });
  });

  it("maskSecret never reveals short secrets and trims long ones", () => {
    expect(maskSecret("abc")).toBe("***");
    const masked = maskSecret("supersecretvalue");
    expect(masked).toBe("su…ue (16 chars)");
    expect(masked).not.toContain("supersecret");
  });
});
