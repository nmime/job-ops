/**
 * Braintrust profile fill — plain fetch, session cookie, idempotent.
 *
 * Run (from the repo root or orchestrator dir):
 *   npx tsx orchestrator/scripts/profile-fill/braintrust.ts
 *
 * Reads the session cookie from data/.credentials/braintrust.txt
 * (single line: "domain: <cookie header>"). No Playwright, no shared deps.
 *
 * Strategy: GET /api/user/user/, diff against the target identity, PATCH only
 * the missing/differing fields (Django REST silently accepts unknown fields
 * with HTTP 200, so the script always re-reads to verify).
 *
 * Known API limits (recorded, not retried):
 *   - Skills are employer-managed on Braintrust; the user skills endpoint is a
 *     no-op (server stays at 0 skills). Browser-only.
 *   - Work history / availability / rate: the app gates save mutations on
 *     automated sessions (NewRelic webdriverDetected) and on
 *     freelancer_approved, and there is no public rate field. Browser-only.
 *   - `title` (display name) is read-only via API.
 *   - Phone number / DOB / address: never touched (privacy lines).
 *
 * Output: strict JSON on stdout.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://app.usebraintrust.com";

const IDENTITY = {
  timezone: "Europe/Berlin",
  headline: "Senior Full-Stack Developer (Node.js/React)",
  // German native / English fluent -> language ids observed on the platform.
  languages: [14, 90],
  introduction:
    "Senior Full-Stack Developer with 5+ years of experience architecting scalable, high-load systems with Node.js and TypeScript. Proven track record in FinTech and GameFi: microservices handling high concurrency and real-time transactions, a high-frequency social trading platform with 30k+ DAU, a P2P payment gateway processing $2M+/month across 15+ payment methods, and WebSocket multiplayer game backends with sub-100ms latency for 500+ concurrent players. Expert in PostgreSQL, Redis, Docker, and event-driven architectures (Kafka, RabbitMQ), and passionate about integrating LLM agents and AI-driven workflows into products. Remote-first, based in Germany.",
};

function findCredFile(name: string): string | null {
  const roots = [
    process.cwd(),
    HERE,
    join(HERE, ".."),
    join(HERE, "..", ".."),
    join(HERE, "..", "..", ".."),
  ];
  for (const root of roots) {
    const p = join(root, "data", ".credentials", `${name}.txt`);
    try {
      readFileSync(p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function loadCookie(name: string): { cookie: string; csrf: string } {
  const path = findCredFile(name);
  if (!path) {
    throw new Error(
      `credential file not found: data/.credentials/${name}.txt (searched from cwd and script dir)`,
    );
  }
  const raw = readFileSync(path, "utf8").trim();
  const header = raw.includes(":") ? raw.split(":").slice(1).join(":").trim() : raw;
  // Drop any non-ASCII cookie pair (corrupted captures) to keep fetch happy.
  const pairs = header
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => /^[\x20-\x7e]*$/.test(c));
  const cookie = pairs.join("; ");
  const csrf =
    pairs
      .map((c) => c.split("="))
      .find(([n]) => n === "csrftoken")?.[1] ?? "";
  if (!cookie) throw new Error(`no usable cookie pairs in ${path}`);
  return { cookie, csrf };
}

async function api(
  path: string,
  method: "GET" | "PATCH",
  cookie: string,
  csrf: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    cookie,
    origin: BASE,
    referer: `${BASE}/profile/`,
    accept: "application/json",
  };
  if (method === "PATCH") {
    headers["content-type"] = "application/json";
    if (csrf) headers["x-csrftoken"] = csrf;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (e.g. auth wall) */
  }
  return { status: res.status, json };
}

type Result = {
  platform: "braintrust";
  apiPossible: boolean;
  implemented: boolean;
  filled: boolean;
  verified: boolean;
  evidence: Record<string, unknown>;
  notes: string[];
};

async function main(): Promise<Result> {
  const notes: string[] = [];
  const { cookie, csrf } = loadCookie("braintrust");

  const first = await api("/api/user/user/", "GET", cookie, csrf);
  // The endpoint returns the user object directly (no envelope).
  if (first.status !== 200 || !first.json?.id) {
    return {
      platform: "braintrust",
      apiPossible: true,
      implemented: true,
      filled: false,
      verified: false,
      evidence: { httpStatus: first.status, blocked: "session invalid or gated" },
      notes: ["GET /api/user/user/ did not return the profile — session expired?"],
    };
  }
  const cur = first.json;
  const userId = cur.id ?? null;

  // Idempotent diff: only send fields that differ.
  const tz = (t: unknown): string =>
    typeof t === "string" ? t : (t as any)?.id ?? (t as any)?.identifier ?? "";
  const langOf = (list: any[]): number[] =>
    (list ?? []).map((l: any) =>
      typeof l === "object" ? (l.language?.id ?? l.id ?? l) : l,
    );
  const patch: Record<string, unknown> = {};
  if (tz(cur.timezone) !== IDENTITY.timezone) {
    patch.timezone = IDENTITY.timezone;
  }
  if ((cur.introduction_headline ?? "") !== IDENTITY.headline) {
    patch.introduction_headline = IDENTITY.headline;
  }
  if ((cur.introduction ?? "") !== IDENTITY.introduction) {
    patch.introduction = IDENTITY.introduction;
  }
  // user_languages entries are nested: {id, language: {id, name, code}, skill_level}
  const langs = langOf(cur.user_languages ?? []);
  if (JSON.stringify(langs.slice().sort((a: number, b: number) => a - b)) !==
      JSON.stringify([...IDENTITY.languages].sort((a, b) => a - b))) {
    patch.user_languages = IDENTITY.languages;
  }

  const wrote = Object.keys(patch);
  if (wrote.length > 0) {
    const put = await api("/api/user/user/", "PATCH", cookie, csrf, patch);
    if (put.status < 200 || put.status > 299) {
      notes.push(
        `PATCH rejected: HTTP ${put.status} ${JSON.stringify(put.json).slice(0, 200)}`,
      );
    }
  }

  // Re-read and verify (Django silently ignores unknown fields — trust the read).
  const after = await api("/api/user/user/", "GET", cookie, csrf);
  const v = after.json ?? {};
  const verified =
    after.status === 200 &&
    tz(v.timezone) === IDENTITY.timezone &&
    v.introduction_headline === IDENTITY.headline &&
    v.introduction === IDENTITY.introduction &&
    JSON.stringify(langOf(v.user_languages ?? []).sort()) ===
      JSON.stringify([...IDENTITY.languages].sort((a, b) => a - b));

  if (wrote.length === 0) {
    notes.push(
      "all target fields already set (idempotent no-op run)",
    );
  } else {
    notes.push(`patched fields: ${wrote.join(", ")}`);
  }
  notes.push(
    "skills: browser-only (employer-managed; direct skills endpoint is a no-op, server stays at 0)",
    "work-history/availability: browser-only (UI save gated on automated sessions + freelancer_approved)",
    "rate: no public rate field in the API — not possible via API",
    "blockedOnUser: phone number not set (privacy line — user must add mobile in UI)",
  );

  return {
    platform: "braintrust",
    apiPossible: true,
    implemented: true,
    filled: verified,
    verified,
    evidence: {
      userId,
      timezone: tz(v.timezone) || null,
      introduction_headline: v.introduction_headline ?? null,
      introduction_chars: (v.introduction ?? "").length,
      user_languages: langOf(v.user_languages ?? []),
      skills_server_side: (v.user_skills ?? []).length,
    },
    notes,
  };
}

main()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
  })
  .catch((err) => {
    console.log(
      JSON.stringify(
        {
          platform: "braintrust",
          apiPossible: true,
          implemented: true,
          filled: false,
          verified: false,
          evidence: { error: String(err?.message ?? err) },
          notes: [],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
