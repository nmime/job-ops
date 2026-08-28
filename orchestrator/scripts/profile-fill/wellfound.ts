/**
 * Wellfound (AngelList) profile fill — plain fetch, persisted GraphQL ops.
 *
 * Run (from the repo root or orchestrator dir):
 *   npx tsx orchestrator/scripts/profile-fill/wellfound.ts
 *
 * Reads the session cookie from data/.credentials/wellfound.txt
 * (single line: "domain: <cookie header>"). Non-ASCII cookie pairs are
 * dropped automatically (corrupted captures).
 *
 * Protocol (discovered from the site's own bundles):
 *   POST https://wellfound.com/graphql
 *   headers: content-type: application/json,
 *            x-requested-with: XMLHttpRequest   (required, else 404)
 *   body: {operationName, variables: {input}, extensions: {operationId: "tfe/<64-hex>"}}
 *   Only persisted operations are accepted (no introspection / raw queries).
 *
 * IMPORTANT: from most non-residential egress IPs Cloudflare TLS-fingerprints
 * this host and serves a challenge page even with a valid session. The
 * script detects that and reports "blocked_by_cf" — run it from a
 * residential connection (or through a browser) for live fills.
 *
 * Idempotent: reads the profile first and only mutates fields that differ.
 *
 * Known API limits (recorded, not retried):
 *   - Education: ProfileSaveEducation 500s on the server for this account
 *     (collegeId 380882 + fullDegreeName + graduationYear). Browser-only.
 *   - Additional work history: FUN Games / Open Builders / Contest Master are
 *     not in Wellfound's startup directory; ProfileSaveExperience requires an
 *     existing startupId. Browser-only ("suggest company").
 *   - PICTURE and DEMOGRAPHICS completeness steps are intentionally skipped
 *     (face photo / personal data beyond the CV).
 *
 * Output: strict JSON on stdout.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://wellfound.com";
const USER_ID = "21663197";

// Persisted operation ids (tfe/ prefix added at call time).
const OPS: Record<string, string> = {
  ProfileEditProfilePage:
    "3787aac6620b88f6f85922dd9f8058c5ba7692e5944a3f74d77631e259717224",
  ProfileSaveBio: "7a19d4a2372ad9057d5ae29abee4582b04de4eccc3df98e078b998fd27e4bed0",
  ProfileSaveSkills:
    "77e6ef40d61e30d1a307c5ad7a11c2a6504c97a5ff407c84c3b813553a97b96a",
  ProfileSaveSocialProfiles:
    "8be924bafedbaa18bea8a94d6b08a05387d7fd05cbe89d710c18e47f3d55d0bd",
  ProfileSaveExpectedSalary:
    "055364c31ba2ec8765802415b61d4af73cc7c244fb66cd57d5edf02083254333",
  ProfileSaveInterestedLocations:
    "2f40fdcf40336ca1617d0a07098d703ed73b35f39a23ec553c4fab962d98624a",
  ProfileSaveExperience:
    "777c6d92342a65218cd4f4db88ee5353ecbd1123956504fa06e934aa2ab89858",
  ProfileSaveEducation:
    "d2168ea96c86c95952d32087da5633b6233d8049fac9bd338f2387c10e8879b1",
};

const IDENTITY = {
  // 244 chars — under the 250-char bio cap enforced by the server.
  bio:
    "Senior Full-Stack Developer, 5+ yrs. Node.js/TypeScript backends at high load: real-time trading platform (30k+ DAU), P2P payments ($2M/mo, 15+ methods), WebSocket game servers. React, PostgreSQL, Redis, Docker, LLM agents. Remote from Germany.",
  // Wellfound skill tag ids.
  skills: [
    "17000", // Node.js
    "94482", // TypeScript
    "139914", // React.js
    "22286", // PostgreSQL
    "21691", // Redis
    "110461", // Docker
    "14781", // Javascript
    "84643", // Websockets
    "258360", // GraphQL
    "87674", // Kafka
    "42639", // Rabbitmq
    "16999", // MongoDB
    "198603", // Kubernetes
    "629815", // CI/CD
    "171817", // AWS
    "81741", // REST APIs
    "17966", // AI
  ],
  linkedinUrl: "https://www.linkedin.com/in/nmime",
  githubUrl: "https://github.com/nmime",
  expectedSalary: 180000,
  currencyCode: "EUR",
  remotePreference: "REMOTE_PREFERRED",
  // Current role (xRocket exists in Wellfound's startup directory).
  experience: {
    startupId: "11194576", // xRocket
    title: "Senior Backend Engineer",
    current: true,
    startedAtYear: 2024,
    startedAtMonth: 5,
  },
  education: {
    collegeId: "380882", // Inha University in Tashkent
    fullDegreeName: "BSc Computer Science",
    graduationYear: 2027,
  },
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

type GqlResult = { status: number; body: string; json: any };

async function gql(
  cookie: string,
  operationName: string,
  variables: Record<string, unknown>,
): Promise<GqlResult> {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      accept: "*/*",
      origin: BASE,
      referer: `${BASE}/profile`,
      cookie,
    },
    body: JSON.stringify({
      operationName,
      variables,
      extensions: { operationId: `tfe/${OPS[operationName]}` },
    }),
  });
  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* HTML (CF challenge) or truncated */
  }
  return { status: res.status, body, json };
}

function looksLikeCloudflare(res: GqlResult): boolean {
  if (res.json) return false;
  return (
    res.status === 403 ||
    res.status === 503 ||
    /security check|cf-challenge|challenge-platform|Just a moment/i.test(
      res.body.slice(0, 4000),
    )
  );
}

function opErrors(res: GqlResult): string[] {
  const errs = res.json?.errors ?? [];
  return errs.map((e: any) => e.message ?? JSON.stringify(e)).slice(0, 3);
}

type Result = {
  platform: "wellfound";
  apiPossible: boolean;
  implemented: boolean;
  filled: boolean;
  verified: boolean;
  evidence: Record<string, unknown>;
  notes: string[];
};

async function readProfile(cookie: string) {
  const res = await gql(cookie, "ProfileEditProfilePage", { userId: USER_ID });
  if (looksLikeCloudflare(res)) return { blocked: true };
  return { blocked: false, candidate: res.json?.data?.candidate ?? null, raw: res };
}

async function main(): Promise<Result> {
  const notes: string[] = [];
  const cookie = loadCookie("wellfound");

  const profile = await readProfile(cookie);
  if (profile.blocked) {
    return {
      platform: "wellfound",
      apiPossible: true,
      implemented: true,
      filled: false,
      verified: false,
      evidence: { blocked_by_cf: true },
      notes: [
        "Cloudflare challenge served to this egress IP (TLS/HTTP2 fingerprinting) — session cookie is valid but direct fetch is blocked; run from a residential connection or drive the same persisted ops from a browser context",
      ],
    };
  }
  if (!profile.candidate) {
    const errs = opErrors(profile.raw as GqlResult);
    return {
      platform: "wellfound",
      apiPossible: true,
      implemented: true,
      filled: false,
      verified: false,
      evidence: { readError: errs },
      notes: ["ProfileEditProfilePage failed — session likely expired"],
    };
  }
  const c = profile.candidate;
  const calls: Array<{ op: string; input: Record<string, unknown>; why: string }> = [];

  if ((c.bio ?? "") !== IDENTITY.bio) {
    calls.push({ op: "ProfileSaveBio", input: { bio: IDENTITY.bio }, why: "bio" });
  }
  const currentSkills = new Set(
    (c.skillTags ?? []).map((t: any) => String(t.id ?? "")),
  );
  const missingSkills = IDENTITY.skills.filter((id) => !currentSkills.has(id));
  if (missingSkills.length > 0) {
    calls.push({
      op: "ProfileSaveSkills",
      input: { skillTags: IDENTITY.skills },
      why: `skills (+${missingSkills.length})`,
    });
  }
  if (c.linkedinUrl !== IDENTITY.linkedinUrl || c.githubUrl !== IDENTITY.githubUrl) {
    calls.push({
      op: "ProfileSaveSocialProfiles",
      input: { linkedinUrl: IDENTITY.linkedinUrl, githubUrl: IDENTITY.githubUrl },
      why: "social links",
    });
  }
  if (
    c.expectedSalary !== IDENTITY.expectedSalary ||
    c.expectedSalaryCurrency?.code !== IDENTITY.currencyCode
  ) {
    calls.push({
      op: "ProfileSaveExpectedSalary",
      input: {
        expectedSalary: IDENTITY.expectedSalary,
        currencyCode: IDENTITY.currencyCode,
      },
      why: "expectedSalary",
    });
  }
  if (c.remotePreference !== IDENTITY.remotePreference) {
    calls.push({
      op: "ProfileSaveInterestedLocations",
      input: { remotePreference: IDENTITY.remotePreference },
      why: "remotePreference",
    });
  }
  const hasXrocket = (c.startupRoleMetadata ?? []).some(
    (r: any) => r.startup?.id === IDENTITY.experience.startupId,
  );
  if (!hasXrocket) {
    calls.push({
      op: "ProfileSaveExperience",
      input: { ...IDENTITY.experience },
      why: "experience (xRocket)",
    });
  }

  const applied: string[] = [];
  const failed: string[] = [];
  for (const call of calls) {
    const res = await gql(cookie, call.op, { input: call.input });
    const errs = opErrors(res);
    if (looksLikeCloudflare(res)) {
      failed.push(`${call.op}: blocked_by_cf mid-run`);
    } else if (errs.length > 0 && !res.json?.data) {
      failed.push(`${call.op}: ${errs.join(" | ")}`);
    } else if (errs.length > 0) {
      failed.push(`${call.op} (partial): ${errs.join(" | ")}`);
    } else {
      applied.push(call.why);
    }
  }
  if (applied.length === 0) {
    notes.push("all target fields already set (idempotent no-op run)");
  } else {
    notes.push(`applied: ${applied.join(", ")}`);
  }
  if (failed.length > 0) {
    notes.push(`failed: ${failed.join(" ;; ")}`);
  }

  // Education: server 500s for this account shape (verified 2026-08-28).
  // Attempted once per run only when the profile has no education yet.
  if (!(c.education ?? []).length) {
    const edu = await gql(cookie, "ProfileSaveEducation", {
      input: { ...IDENTITY.education },
    });
    const eduErrs = opErrors(edu);
    if (eduErrs.length || !edu.json?.data?.candidate) {
      notes.push(
        "education: browser-only (ProfileSaveEducation returns internal_server_error for this account)",
      );
    } else {
      applied.push("education");
    }
  }
  notes.push(
    "work-history (FUN Games / Open Builders / Contest Master): browser-only — employers not in Wellfound's startup directory, ProfileSaveExperience needs an existing startupId",
    "PICTURE + DEMOGRAPHICS completeness steps intentionally skipped (face photo / personal data)",
  );

  // Final verification read.
  const after = await readProfile(cookie);
  const verified =
    !after.blocked &&
    (after.candidate?.bio ?? "") === IDENTITY.bio &&
    IDENTITY.skills.every((id) =>
      (after.candidate?.skillTags ?? []).some(
        (t: any) => String(t.id) === id,
      ),
    ) &&
    after.candidate?.linkedinUrl === IDENTITY.linkedinUrl &&
    after.candidate?.githubUrl === IDENTITY.githubUrl &&
    after.candidate?.expectedSalary === IDENTITY.expectedSalary &&
    after.candidate?.remotePreference === IDENTITY.remotePreference;

  const v = after.candidate ?? {};
  return {
    platform: "wellfound",
    apiPossible: true,
    implemented: true,
    filled: verified,
    verified,
    evidence: {
      name: v.user?.name ?? null,
      bio: (v.bio ?? "").slice(0, 120) + "…",
      skills: (v.skillTags ?? []).length,
      linkedinUrl: v.linkedinUrl ?? null,
      githubUrl: v.githubUrl ?? null,
      expectedSalary: v.expectedSalary ?? null,
      currency: v.expectedSalaryCurrency?.code ?? null,
      remotePreference: v.remotePreference ?? null,
      roles: (v.startupRoleMetadata ?? []).map((r: any) => ({
        title: r.title,
        startup: r.startup?.name ?? null,
        current: r.current,
      })),
      education: (v.education ?? []).length,
      pendingSteps: v.pendingProfileCompletenessSteps ?? [],
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
          platform: "wellfound",
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
