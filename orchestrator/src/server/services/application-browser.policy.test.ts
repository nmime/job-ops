import { describe, expect, it } from "vitest";
import {
  classifyPortalPageTextForSession,
  classifyPortalUrlForSession,
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
  });

  it("detects CAPTCHA and challenge pages without attempting paid solve", () => {
    expect(
      inspectPortalHtmlForAutoApply(
        "<title>Security check</title><p>Cloudflare challenge: verify you are human with CAPTCHA.</p>",
      ),
    ).toMatchObject({ captchaRequired: true });
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
      inspectPortalHtmlForAutoApply(
        "<h1>Thank you</h1><p>Your application submitted successfully.</p>",
      ),
    ).toMatchObject({ hasSuccessSignal: true });
  });
});
