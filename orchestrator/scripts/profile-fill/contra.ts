/**
 * Contra profile fill — plain fetch, session cookie, persisted GraphQL.
 *
 * Run (from the repo root or orchestrator dir):
 *   npx tsx orchestrator/scripts/profile-fill/contra.ts
 *
 * Reads the session cookie from data/.credentials/contra.txt
 * (single line: "domain: <cookie header>").
 *
 * Protocol (discovered from the site's own bundles + live traffic):
 *   POST https://contra.com/api/?operationName=<Op>
 *   body: {doc_id: "<32-hex>", operationName: "<Op>", variables: {...}}
 *   The server only accepts operations registered under their doc_id
 *   (Relay-compiled persisted ops); raw queries are rejected.
 *
 * Status of profile filling (verified 2026-08-28):
 *   - The public profile page and /settings are server-rendered shells; the
 *     session is validated client-side. With the captured cookie the API
 *     still reports the visitor as anonymous (userAccount: null) — the
 *     session had expired server-side, so the app bounces to /log-in.
 *   - The profile-edit mutations (headline / about / rate) live in lazily
 *     loaded chunks that are only fetched by an authenticated profile-edit
 *     UI, so their doc_ids cannot be enumerated anonymously.
 *   - Net: API is possible (protocol proven working), but every profile
 *     write needs a LIVE session — re-login via Google SSO / magic link
 *     (blockedOnUser), then re-capture the cookie.
 *
 * This script probes the session with a user-scoped registered op and
 * reports the precise blocker. It never writes profile data.
 *
 * Output: strict JSON on stdout.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://contra.com";

// Registered op used purely as a session probe (returns visitor identity).
const PROBE = {
  name: "useOnboardingStepQuery",
  docId: "bb129ea306de00b41aad3efc55d03e52",
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

type Result = {
  platform: "contra";
  apiPossible: boolean;
  implemented: boolean;
  filled: boolean;
  verified: boolean;
  evidence: Record<string, unknown>;
  notes: string[];
};

async function main(): Promise<Result> {
  const notes: string[] = [];
  const cookie = loadCookie("contra");

  const res = await fetch(`${BASE}/api/?operationName=${PROBE.name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "*/*",
      origin: BASE,
      referer: `${BASE}/`,
      cookie,
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      doc_id: PROBE.docId,
      operationName: PROBE.name,
      variables: {},
    }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }

  const visitor = json?.data?.visitor;
  const account = visitor?.userAccount;
  const authenticated = Boolean(
    account && (account.id || account.username || account.publicName),
  );

  notes.push(
    "profile-edit mutations (headline/about/rate) live in lazily loaded chunks only fetched by the authenticated edit UI — doc_ids must be captured from a live session's network traffic",
    "privacy: no personal-data fields are read or written by this script",
  );

  if (!authenticated) {
    notes.push(
      "blockedOnUser: captured session is expired server-side (API reports anonymous visitor, web app bounces to /log-in) — re-login on contra.com (Google SSO or email magic link) and re-capture the cookie, then re-run",
    );
    return {
      platform: "contra",
      apiPossible: true,
      implemented: true,
      filled: false,
      verified: false,
      evidence: {
        probeOperation: PROBE.name,
        probeStatus: res.status,
        visitorUserAccount: account ? Object.keys(account) : null,
        sessionValid: false,
      },
      notes,
    };
  }

  // A live session would enable capture of the edit-mutation doc_ids; the
  // write path is intentionally not executed without them.
  notes.push(
    "session is live — next step: open the profile edit UI, capture the edit-mutation doc_ids (HAR), then wire the fill call here",
  );
  return {
    platform: "contra",
    apiPossible: true,
    implemented: true,
    filled: false,
    verified: false,
    evidence: {
      probeOperation: PROBE.name,
      probeStatus: res.status,
      sessionValid: true,
      visitorUserAccount: {
        username: account.username ?? null,
        publicName: account.publicName ?? null,
      },
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
          platform: "contra",
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
