import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Credential store.
 *
 * Layout: <baseDir>/.credentials/<platform>.txt with `key: value` lines.
 * Files are created 0600 and directories 0700. Values are never logged by
 * this module; callers must treat them as secrets.
 */

const LINE_RE = /^([a-z0-9_.-]+):\s*(.*)$/;

export interface StoredCredential {
  platform: string;
  fields: Record<string, string>;
  path: string;
}

export function credentialFilePath(baseDir: string, platform: string): string {
  return path.join(baseDir, ".credentials", `${platform}.txt`);
}

export function parseCredentialText(
  platform: string,
  text: string,
  filePath?: string,
): StoredCredential {
  const fields: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    fields[m[1]] = m[2].trim();
  }
  return { platform, fields, path: filePath ?? "" };
}

export function serializeCredential(fields: Record<string, string>): string {
  return `${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n`;
}

export function readCredential(
  baseDir: string,
  platform: string,
): StoredCredential | null {
  const file = credentialFilePath(baseDir, platform);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  return parseCredentialText(platform, text, file);
}

export function writeCredential(
  baseDir: string,
  platform: string,
  fields: Record<string, string>,
): string {
  const dir = path.join(baseDir, ".credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialFilePath(baseDir, platform);
  writeFileSync(file, serializeCredential(fields), { mode: 0o600 });
  // Re-assert in case the file pre-existed with a looser mode.
  chmodSync(file, 0o600);
  return file;
}

export function updateCredential(
  baseDir: string,
  platform: string,
  patch: Record<string, string>,
): string {
  const existing = readCredential(baseDir, platform)?.fields ?? {};
  return writeCredential(baseDir, platform, { ...existing, ...patch });
}

/** Mask a secret for safe logging: keep first 2 and last 2 chars when long enough. */
export function maskSecret(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}…${value.slice(-2)} (${value.length} chars)`;
}
