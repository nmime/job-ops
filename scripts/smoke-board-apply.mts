/* Smoke-test the new board apply adapters WITHOUT ever touching a real
   employer:
   1. dryRun guard returns skipped (both platforms)
   2. unknown gig -> drafted with a precise error (no browser)
   3. dedup-hash lookup re-resolves live board gigs to their posting URLs
   4. the portal driver (external apply link / form signal / fill / consent /
      resume attach / submit / success-signal / captcha) works against a
      LOCAL fake ATS on a separate host, and "submitted" is only possible
      with a confirmed success signal
*/
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ro = await import("../extractors/remoteok/src/main.ts");
const wwr = await import("../extractors/weworkremotely/src/main.ts");

// local copy of the orchestrator dedupe algorithm (same 3 functions)
function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(senior|junior|sr|jr|lead|staff|principal)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|gclid|fbclid|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    let path = url.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}
function hashOf(gig: { gigUrl: string; title: string; clientOrEmployer: string }): string {
  const url = canonicalizeUrl(gig.gigUrl);
  const key = `${normalizeForCompare(gig.title)}|${normalizeForCompare(gig.clientOrEmployer)}`;
  return createHash("sha256").update(`${url}::${key}`).digest("hex").slice(0, 32);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. dry-run guard
const roDry = await ro.applyToRemoteOkGig({
  platform: "remoteok", gigId: "abc123", dryRun: true, allowCaptcha: false,
  rateBudget: { maxPerHour: 5, windowMs: 3_600_000 }, profile: null,
});
check("remoteok dryRun -> skipped", roDry.status === "skipped" && roDry.mode === "dry_run", roDry.error ?? "");
const wwrDry = await wwr.applyToWwrGig({
  platform: "weworkremotely", gigId: "abc123", dryRun: true, allowCaptcha: false,
  rateBudget: { maxPerHour: 5, windowMs: 3_600_000 }, profile: null,
});
check("weworkremotely dryRun -> skipped", wwrDry.status === "skipped" && wwrDry.mode === "dry_run", wwrDry.error ?? "");

// 2. unknown gig -> drafted
const roUnknown = await ro.applyToRemoteOkGig({
  platform: "remoteok", gigId: "nonexistent-gig-id", dryRun: false, allowCaptcha: false,
  rateBudget: { maxPerHour: 5, windowMs: 3_600_000 }, profile: null,
});
check("remoteok unknown gig -> drafted", roUnknown.status === "drafted", roUnknown.error ?? "");

// 3. live feeds: gig id -> posting URL via dedup hash (stops before browser)
const noopCtx = { platform: "remoteok", searchTerms: [], selectedCountry: "US", settings: {} };
const roFind = await ro.findRemoteOkGigs(noopCtx as never);
check("remoteok finder returns gigs", roFind.success && roFind.gigs.length > 0, `gigs=${roFind.gigs.length}`);
if (roFind.gigs.length > 0) {
  const g = roFind.gigs[0];
  const roHash = hashOf(g);
  console.log(`  remoteok target: ${g.title} @ ${g.gigUrl} (hash ${roHash})`);
  const resolved = await ro.applyToRemoteOkGig({
    platform: "remoteok", gigId: roHash, dryRun: false, allowCaptcha: false,
    rateBudget: { maxPerHour: 5, windowMs: 3_600_000 }, profile: null,
  });
  check(
    "remoteok known gig -> lookup OK, stops at missing profile",
    resolved.status === "drafted" && /no candidate profile/.test(resolved.error ?? ""),
    resolved.error ?? "",
  );
}
const wwrFind = await wwr.findWwrGigs(noopCtx as never);
check("weworkremotely finder returns gigs", wwrFind.success && wwrFind.gigs.length > 0, `gigs=${wwrFind.gigs.length}`);
if (wwrFind.gigs.length > 0) {
  const g = wwrFind.gigs[0];
  const wwrHash = hashOf(g);
  console.log(`  wwr target: ${g.title} @ ${g.gigUrl} (hash ${wwrHash})`);
  const resolved = await wwr.applyToWwrGig({
    platform: "weworkremotely", gigId: wwrHash, dryRun: false, allowCaptcha: false,
    rateBudget: { maxPerHour: 5, windowMs: 3_600_000 }, profile: null,
  });
  check(
    "weworkremotely known gig -> lookup OK, stops at missing profile",
    resolved.status === "drafted" && /no candidate profile/.test(resolved.error ?? ""),
    resolved.error ?? "",
  );
}

// profile extraction
const resumePath = join(tmpdir(), "smoke-resume.pdf");
writeFileSync(resumePath, Buffer.from("%PDF-1.4 fake resume for smoke test"));
const identity = ro.extractApplyIdentity(
  {
    basics: {
      name: "Nikita Testov",
      email: "nikita.test@example.com",
      phone: "+1 555 0100",
      url: "https://nikita.example",
      headline: "Backend engineer",
      summary: "I build APIs. <b>Fast</b> ones.",
      location: { city: "Berlin", region: "DE", countryCode: "DE" },
    },
    resumePath,
  },
  { title: "Senior Backend Engineer", clientOrEmployer: "Acme", gigUrl: "x" },
);
check(
  "extractApplyIdentity parses ResumeProfile shape + resume path",
  Boolean(identity) &&
    identity.firstName === "Nikita" &&
    identity.lastName === "Testov" &&
    identity.email === "nikita.test@example.com" &&
    identity.phone === "+1 555 0100" &&
    identity.location.includes("Berlin") &&
    identity.resumePath === resumePath &&
    /Senior Backend Engineer/.test(identity.coverLetter),
  identity ? `first=${identity.firstName} last=${identity.lastName} loc=${identity.location}` : "null",
);
const flat = ro.extractApplyIdentity(
  { name: "Flat Person", email: "flat@example.com", coverLetter: "Hello" },
  { title: "Dev", clientOrEmployer: "X", gigUrl: "x" },
);
check("extractApplyIdentity accepts flat shape", Boolean(flat) && flat.coverLetter === "Hello");
check(
  "extractApplyIdentity rejects empty profile",
  ro.extractApplyIdentity(null, { title: "t", clientOrEmployer: "c", gigUrl: "x" }) === null &&
    ro.extractApplyIdentity({ phone: "123" }, { title: "t", clientOrEmployer: "c", gigUrl: "x" }) === null,
);

// 4. hermetic browser test: board page (127.0.0.1) + external fake ATS (127.0.0.2)
const atsForm = `<!doctype html><html><head><title>Senior Backend Engineer | Acme</title></head><body>
<h1>Senior Backend Engineer at Acme</h1>
<button id="cookie" type="button">Accept all</button>
<form action="/submit" method="post">
  <input name="firstName" placeholder="First name" />
  <input name="lastName" placeholder="Last name" />
  <input type="email" name="email" placeholder="Email" />
  <input type="tel" name="phone" placeholder="Phone" />
  <input name="website" placeholder="Website" />
  <input name="location" placeholder="Location" />
  <textarea name="message" placeholder="Cover letter"></textarea>
  <input type="file" name="resume" />
  <label><input type="checkbox" name="consent" /> I agree to the privacy policy and consent to data processing</label>
  <button type="submit">Submit application</button>
</form>
</body></html>`;

const thanksPage = `<!doctype html><html><head><title>Thanks</title></head><body>
<h1>Thank you for applying</h1><p>Your application has been submitted.</p>
</body></html>`;

const stuckPage = `<!doctype html><html><head><title>Acme Careers</title></head><body>
<form><input name="email" /><button type="button" onclick="return false">Submit application</button></form>
</body></html>`;

const captchaPage = `<!doctype html><html><head><title>Acme Careers</title></head><body>
<form><input name="email" /></form>
<div class="g-recaptcha" data-sitekey="fake-site-key-123"></div>
</body></html>`;

const boardLinksPage = `<!doctype html><html><head><title>Acme job</title></head><body>
<h1>Senior Backend Engineer</h1>
<a href="ATS_BASE/ats">Apply now</a>
</body></html>`;

const received: Record<string, string> = {};
const boardServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    req.url === "/stuck" ? stuckPage : req.url === "/captcha" ? captchaPage : boardLinksPage,
  );
});
const atsServer = createServer((req, res) => {
  if (req.url === "/submit" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.body = body;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(thanksPage);
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(atsForm);
});
await new Promise<void>((r) => boardServer.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => atsServer.listen(0, "127.0.0.2", r));
const boardPort = (boardServer.address() as { port: number }).port;
const atsPort = (atsServer.address() as { port: number }).port;
const boardBase = `http://127.0.0.1:${boardPort}`;
const atsBase = `http://127.0.0.2:${atsPort}`;
const linksPage = boardLinksPage.replace("ATS_BASE", atsBase);
// patch board server to serve the patched page
boardServer.removeAllListeners("request");
boardServer.on("request", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    req.url === "/stuck" ? stuckPage : req.url === "/captcha" ? captchaPage : linksPage,
  );
});

try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  check("chromium launches", true, browser.version());
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });

  // 4a. external apply link on the board posting
  const page = await context.newPage();
  await ro.installStealth(page);
  page.setDefaultNavigationTimeout(30_000);
  await page.goto(`${boardBase}/`, { waitUntil: "domcontentloaded" });
  const ext = await ro.findExternalApplyUrl(page);
  check("findExternalApplyUrl finds the external ATS link", ext === `${atsBase}/ats`, String(ext));
  check("hasApplicationFormSignal false on plain board page", (await ro.hasApplicationFormSignal(page)) === false);

  // 4b. full flow on the external fake ATS
  await page.goto(`${atsBase}/ats`, { waitUntil: "domcontentloaded" });
  check("hasApplicationFormSignal true on fake ATS", (await ro.hasApplicationFormSignal(page)) === true);
  check("detectCaptcha none on fake ATS", (await ro.detectCaptcha(page)) === null);
  await ro.dismissCookieOverlays(page);
  const filled = await ro.fillApplicationForm(page, identity as NonNullable<typeof identity>);
  check("fillApplicationForm fills the form", filled >= 5, `fieldsFilled=${filled}`);
  const consent = await page.evaluate(() => (document.querySelector('input[name="consent"]') as HTMLInputElement).checked);
  check("consent checkbox checked", consent === true);
  const uploaded = await ro.uploadResume(page, resumePath);
  check("uploadResume attaches the file to the input", uploaded === true);
  const fileState = await page.evaluate(() => {
    const el = document.querySelector('input[type="file"]') as HTMLInputElement;
    const f = el.files && el.files[0];
    return f ? { name: f.name, size: f.size } : null;
  });
  check(
    "resume file present in the DOM after upload",
    fileState !== null && fileState.name.endsWith("smoke-resume.pdf") && fileState.size > 0,
    JSON.stringify(fileState),
  );

  const submit = await ro.clickSubmit(page);
  check("clickSubmit clicks the real submit control", submit.clicked === true, `url=${submit.page.url()}`);
  await submit.page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await submit.page.waitForTimeout(300);
  check(
    "form POST reached the fake ATS (filled fields really sent)",
    /Nikita/.test(received.body ?? "") &&
      /nikita\.test(%40|@)example\.com/.test(received.body ?? "") &&
      /consent=on/.test(received.body ?? ""),
    (received.body ?? "").slice(0, 160),
  );
  const success = await ro.hasSuccessSignal(submit.page, { hadForm: true });
  check("hasSuccessSignal confirms the thank-you page", success === true, submit.page.url());

  // 4c. negative: stuck form must NOT confirm
  const page2 = await context.newPage();
  await ro.installStealth(page2);
  await page2.goto(`${boardBase}/stuck`, { waitUntil: "domcontentloaded" });
  const submit2 = await ro.clickSubmit(page2);
  const success2 = await ro.hasSuccessSignal(submit2.page, { hadForm: false });
  check(
    "no confirmed success on a stuck form (no fake submissions)",
    success2 === false,
    `clicked=${submit2.clicked} url=${submit2.page.url()}`,
  );

  // 4d. captcha detection positive case
  const page3 = await context.newPage();
  await ro.installStealth(page3);
  await page3.goto(`${boardBase}/captcha`, { waitUntil: "domcontentloaded" });
  check("detectCaptcha finds a reCAPTCHA sitekey", (await ro.detectCaptcha(page3)) === "recaptcha-v2");

  await browser.close();
} catch (error) {
  check("hermetic browser test ran", false, String(error).slice(0, 300));
} finally {
  boardServer.close();
  atsServer.close();
}

console.log(failures === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures} SMOKE CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
