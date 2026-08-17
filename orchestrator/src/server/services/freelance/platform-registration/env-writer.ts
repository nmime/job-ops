/**
 * .env writer — pure text transformations, no I/O.
 *
 * Rules:
 *  - `KEY=value` lines are matched case-sensitively on the bare key.
 *  - An existing assignment is replaced IN PLACE (position and quoting style
 *    of the value are normalized to unquoted unless the value needs quotes).
 *  - A missing key is appended at the end with a short comment.
 *  - Comments and blank lines are preserved verbatim.
 */

export interface EnvWriteResult {
  text: string;
  changed: boolean;
  action: "updated" | "appended" | "unchanged";
}

const needsQuotes = (v: string): boolean => v === "" || /[\s#"'\\]/.test(v);

export function formatEnvLine(key: string, value: string): string {
  return needsQuotes(value)
    ? `${key}="${value.replace(/"/g, '\\"')}"`
    : `${key}=${value}`;
}

export function setEnvVar(
  text: string,
  key: string,
  value: string,
  comment?: string,
): EnvWriteResult {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${key}=.*$`);
  const idx = lines.findIndex((l) => re.test(l.trim()));

  if (idx >= 0) {
    if (lines[idx].trim() === formatEnvLine(key, value)) {
      return { text, changed: false, action: "unchanged" };
    }
    lines[idx] = formatEnvLine(key, value);
    return { text: lines.join("\n"), changed: true, action: "updated" };
  }

  const block: string[] = [];
  if (comment) block.push(`# ${comment}`);
  block.push(formatEnvLine(key, value));
  // Keep the file ending with a single newline.
  const base =
    lines.length > 0 && lines[lines.length - 1] === ""
      ? lines.slice(0, -1)
      : lines;
  return {
    text: [...base, ...block, ""].join("\n"),
    changed: true,
    action: "appended",
  };
}

export function getEnvVar(text: string, key: string): string | null {
  const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return null;
  let v = m[1].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v;
}
