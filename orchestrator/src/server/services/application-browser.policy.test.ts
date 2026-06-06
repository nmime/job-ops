import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPortalPageTextForSession,
  classifyPortalUrlForSession,
  detectPortalBlockerFromSnapshot,
  evaluatePortalDomainPolicy,
  inspectPortalHtmlForAutoApply,
  isFullAutoBrowserSubmitEnabled,
  isFullAutoCaptchaEnabled,
} from "./application-browser";

describe("portal auto-apply safety policy", () => {
  it("keeps browser submit and paid CAPTCHA off unless each explicit gate is set", () => {
    expect(
      isFullAutoBrowserSubmitEnabled({
        JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
      }),
    ).toBe(false);
    expect(
      isFullAutoBrowserSubmitEnabled({
        JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
        JOBOPS_AUTONOMOUS_PORTAL_APPLY_ENABLED: "true",
      }),
    ).toBe(true);
    expect(
      isFullAutoCaptchaEnabled({ JOBOPS_FULL_AUTO_APPLY_ENABLED: "true" }),
    ).toBe(false);
    expect(
      isFullAutoCaptchaEnabled({
        JOBOPS_FULL_AUTO_APPLY_ENABLED: "true",
        JOBOPS_AUTONOMOUS_CAPTCHA_APPLY_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("allows only configured direct ATS/company domains", () => {
    expect(
      evaluatePortalDomainPolicy("https://boards.greenhouse.io/acme/jobs/1", {
        JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS:
          "greenhouse.io, jobs.example.com",
      }),
    ).toMatchObject({ allowed: true, domain: "boards.greenhouse.io" });

    expect(
      evaluatePortalDomainPolicy("https://workday.example.org/job/1", {
        JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "greenhouse.io",
      }),
    ).toMatchObject({
      allowed: false,
      reasonCode: "domain_not_allowlisted",
    });
  });

  it("requires a validated session for LinkedIn and Indeed by default", () => {
    expect(
      evaluatePortalDomainPolicy("https://linkedin.com/jobs/view/1", {
        JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "linkedin.com",
      }),
    ).toMatchObject({ allowed: false, reasonCode: "session_required" });

    expect(
      evaluatePortalDomainPolicy("https://indeed.com/viewjob?jk=1", {
        JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "indeed.com",
        JOBOPS_AUTONOMOUS_PORTAL_SESSION_VALIDATED_DOMAINS: "indeed.com",
      }),
    ).toMatchObject({ allowed: true, hasValidatedSession: true });
  });

  it("accepts storage-state cookies as session validation support", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobops-storage-state-"));
    const storageStatePath = join(dir, "state.json");
    writeFileSync(
      storageStatePath,
      JSON.stringify({
        cookies: [
          {
            name: "li_at",
            value: "redacted",
            domain: ".linkedin.com",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
        ],
        origins: [],
      }),
    );

    expect(
      evaluatePortalDomainPolicy("https://www.linkedin.com/jobs/view/1", {
        JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS: "linkedin.com",
        JOBOPS_FULL_AUTO_BROWSER_STORAGE_STATE_PATH: storageStatePath,
      }),
    ).toMatchObject({ allowed: true, hasValidatedSession: true });
  });

  it("classifies login and session-gated portal URLs", () => {
    expect(
      classifyPortalUrlForSession(
        "https://linkedin.com/login?session_redirect=/jobs/view/1",
      ),
    ).toMatchObject({ provider: "linkedin" });
    expect(
      classifyPortalUrlForSession("https://indeed.com/viewjob?jk=1"),
    ).toMatchObject({ provider: "indeed" });
    expect(
      classifyPortalUrlForSession("https://jobs.example.com/sign-in/apply"),
    ).toMatchObject({ provider: "generic" });
  });

  it("detects login/sign-up walls before submit", () => {
    expect(
      classifyPortalPageTextForSession({
        url: "https://jobs.example.com/apply",
        text: "Sign in to continue your application for this job or create an account.",
        hasPasswordField: true,
        hasApplicationFormSignal: false,
      }),
    ).toEqual({
      type: "needs_portal_session",
      provider: "generic",
      reason:
        "Portal page is showing sign-in/sign-up controls instead of an application form.",
    });
    expect(
      detectPortalBlockerFromSnapshot({
        title: "Sign in",
        text: "Sign in to continue your application for this job or create an account.",
      }),
    ).toEqual({
      code: "login_wall",
      reason: "Portal requires login/sign-up before application submission.",
    });
  });

  it("detects CAPTCHA and challenge pages without attempting paid solve", () => {
    expect(
      inspectPortalHtmlForAutoApply(
        "<title>Security check</title><p>Cloudflare challenge: verify you are human with CAPTCHA.</p>",
      ),
    ).toMatchObject({ captchaRequired: true });
    expect(
      detectPortalBlockerFromSnapshot({
        title: "Security check",
        text: "Cloudflare checking if the site connection is secure. Verify you are human.",
      }),
    ).toMatchObject({ code: "captcha_challenge" });
  });

  it("detects required-field and local success signals", () => {
    expect(
      inspectPortalHtmlForAutoApply(
        "<form><p>Please fill the missing field.</p><input name='portfolio' required><button>Submit application</button></form>",
      ),
    ).toMatchObject({
      hasApplicationFormSignal: true,
      hasBlockingErrorSignal: true,
      requiredIssueCount: 1,
    });
    expect(
      detectPortalBlockerFromSnapshot(
        {
          text: "Please complete all required fields before submitting.",
          fields: [
            {
              required: true,
              value: "",
              type: "text",
              name: "portfolio",
              visible: true,
            },
          ],
        },
        { includeRequiredFields: true },
      ),
    ).toMatchObject({ code: "required_or_invalid_fields" });
    expect(
      inspectPortalHtmlForAutoApply(
        "<h1>Thank you</h1><p>Your application submitted successfully.</p>",
      ),
    ).toMatchObject({ hasSuccessSignal: true });
    expect(
      detectPortalBlockerFromSnapshot({
        title: "Apply",
        text: "Review your application and submit when ready.",
      }),
    ).toBeNull();
  });
});
