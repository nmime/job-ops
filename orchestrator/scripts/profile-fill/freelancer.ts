/**
 * Freelancer.com profile fill — plain fetch, session cookie + optional OAuth.
 *
 * Run (from the repo root or orchestrator dir):
 *   npx tsx orchestrator/scripts/profile-fill/freelancer.ts
 *
 * Reads the session cookie from data/.credentials/freelancer.txt
 * (single line: "domain: <cookie header>").
 *
 * Auth model (verified live):
 *   - READS work with the session cookie alone:
 *       GET https://www.freelancer.com/api/users/0.1/self
 *   - WRITES return 401 "You must be logged in" with the session cookie and
 *     require an OAuth token (Freelancer-OAuth-V1 header) from
 *     https://www.freelancer.com/api (user-generated). If the env var
 *     FREELANCER_API_KEY (or JOBOPS_FREELANCE_FREELANCER_API_KEY) is set,
 *     the script performs the writes; otherwise it reports
 *     writes_skipped: needs_oauth_token.
 *
 * Account gate (verified live 2026-08-28): the account
 * (user 94514468, @nikitan0xeid) is NOT email-verified; the web app shows a
 * "Verification Required" wall that blocks the profile-edit UI until the user
 * clicks the verification link in their inbox. The script detects
 * status.email_verified=false and reports blocked_on_user: verify email.
 *
 * Privacy lines: date_of_birth, phone (marketing_mobile_number / secure_phone)
 * and email are NEVER read into output or written.
 *
 * Idempotent: GETs the profile, diffs, writes only what differs.
 *
 * Output: strict JSON on stdout.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://www.freelancer.com/api";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const IDENTITY = {
  tagline:
    "Senior Full-Stack Developer (Node.js/TypeScript backend, React frontend, real-time systems, agentic AI)",
  profileDescription:
    "Senior Full-Stack Developer with 5+ years of experience architecting scalable, high-load systems with Node.js and TypeScript. Proven track record in FinTech and GameFi: microservices handling high concurrency and real-time transactions, a high-frequency social trading platform with 30k+ DAU, a P2P payment gateway processing $2M+/month across 15+ payment methods, and WebSocket multiplayer game backends with sub-100ms latency for 500+ concurrent players. Expert in PostgreSQL, Redis, Docker, and event-driven architectures (Kafka, RabbitMQ), and passionate about integrating LLM agents and AI-driven workflows into products. Remote-first, based in Germany.",
  // 685 EUR/day identity rate -> 85 EUR/h (profile primary currency is EUR).
  hourlyRate: 85,
  city: "Falkenstein",
  timezoneId: 245, // Europe/Berlin
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

function loadCookie(name: string): string {
  const path = findCredFile(name);
  if (!path) {
    throw new Error(
      `credential file not found: data/.credentials/${name}.txt (searched from cwd and script dir)`,
    );
  }
  const raw = readFileSync(path, "utf8").trim();
  const header = raw.includes(":") ? raw.split(":").slice(1).join(":").trim() : raw;
  const pairs = header
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => /^[\x20-\x7e]*$/.test(c));
  const cookie = pairs.join("; ");
  if (!cookie) throw new Error(`no usable cookie pairs in ${path}`);
  return cookie;
}

const oauthKey =
  process.env.JOBOPS_FREELANCE_FREELANCER_API_KEY ??
  process.env.FREELANCER_API_KEY ??
  undefined;

async function api(
  path: string,
  method: "GET" | "PUT" | "PATCH",
  cookie: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json",
    referer: "https://www.freelancer.com/profile/edit",
    origin: "https://www.freelancer.com",
    cookie,
    "x-requested-with": "XMLHttpRequest",
  };
  if (oauthKey) headers["freelancer-oauth-v1"] = oauthKey;
  if (body) headers["content-type"] = "application/json";
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
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

type Result = {
  platform: "freelancer";
  apiPossible: boolean;
  implemented: boolean;
  filled: boolean;
  verified: boolean;
  evidence: Record<string, unknown>;
  notes: string[];
};

async function main(): Promise<Result> {
  const notes: string[] = [];
  const cookie = loadCookie("freelancer");

  const me = await api("/users/0.1/self?status=true&limited_account=true&webapp=1", "GET", cookie);
  const user = me.json?.result;
  if (me.status !== 200 || !user) {
    return {
      platform: "freelancer",
      apiPossible: true,
      implemented: true,
      filled: false,
      verified: false,
      evidence: { httpStatus: me.status, error: me.json?.message ?? me.text.slice(0, 120) },
      notes: ["GET /api/users/0.1/self failed — session cookie expired?"],
    };
  }

  const emailVerified = user.status?.email_verified === true;
  const blocked: string[] = [];
  if (!emailVerified) {
    blocked.push(
      "blockedOnUser: account email is not verified — the profile-edit UI shows a 'Verification Required' wall; user must click the verification link sent to their inbox (Resend Email available in the app)",
    );
  }
  if (!oauthKey) {
    blocked.push(
      "writes_skipped: session cookie authenticates reads only; profile writes need an OAuth token (Freelancer-Oauth-V1) from the Freelancer API console — set FREELANCER_API_KEY to enable",
    );
  }

  // Idempotent diff.
  const patch: Record<string, unknown> = {};
  if ((user.tagline ?? "") !== IDENTITY.tagline) patch.tagline = IDENTITY.tagline;
  if ((user.profile_description ?? "") !== IDENTITY.profileDescription) {
    patch.profile_description = IDENTITY.profileDescription;
  }
  if (user.hourly_rate !== IDENTITY.hourlyRate) patch.hourly_rate = IDENTITY.hourlyRate;
  if ((user.address?.city ?? "") !== IDENTITY.city) {
    patch.address = { ...(user.address ?? {}), city: IDENTITY.city };
    delete (patch.address as any).address1; // keep only city change minimal
    (patch.address as any).address1 = null;
  }
  if (user.timezone?.id !== IDENTITY.timezoneId) patch.timezone_id = IDENTITY.timezoneId;

  const wrote = Object.keys(patch);
  if (wrote.length > 0 && !blocked.length) {
    const put = await api(`/users/0.1/users/${user.id}`, "PUT", cookie, patch);
    if (put.status === 401 || put.status === 403) {
      blocked.push(
        `write rejected: HTTP ${put.status} ${put.json?.message ?? ""} (OAuth token required or missing scope)`,
      );
    } else if (!put.json?.status || put.json.status !== "success") {
      blocked.push(`write failed: HTTP ${put.status} ${put.json?.message ?? put.text.slice(0, 160)}`);
    } else {
      notes.push(`patched fields: ${wrote.join(", ")}`);
    }
  } else if (wrote.length > 0) {
    notes.push(`pending fields (blocked): ${wrote.join(", ")}`);
  } else {
    notes.push("all target fields already set (idempotent no-op run)");
  }

  // Re-read and verify what the platform actually shows.
  const afterRes = await api("/users/0.1/self?status=true&webapp=1", "GET", cookie);
  const v = afterRes.json?.result ?? user;
  const verified =
    emailVerified &&
    (v.tagline ?? "") === IDENTITY.tagline &&
    (v.profile_description ?? "") === IDENTITY.profileDescription &&
    v.hourly_rate === IDENTITY.hourlyRate &&
    (v.address?.city ?? "") === IDENTITY.city;

  notes.push(
    "skills: no user-scoped skill endpoint found (GET /users/0.1/self exposes jobs=null); skill tagging is browser-only",
    "work-history / education: not part of the freelancer.com profile API (resume-based); browser-only",
    "privacy: date_of_birth / phone / email never read into output or written",
  );

  return {
    platform: "freelancer",
    apiPossible: true,
    implemented: true,
    filled: verified,
    verified,
    evidence: {
      userId: v.id ?? null,
      username: v.username ?? null,
      email_verified: emailVerified,
      profile_complete: v.status?.profile_complete ?? null,
      tagline: v.tagline ?? null,
      profile_description_chars: (v.profile_description ?? "").length,
      hourly_rate: v.hourly_rate ?? null,
      currency: v.primary_currency?.code ?? null,
      city: v.address?.city ?? null,
      timezone: v.timezone?.timezone ?? null,
      oauth_configured: Boolean(oauthKey),
    },
    notes: [...blocked, ...notes],
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
          platform: "freelancer",
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
