import { describe, expect, it } from "vitest";
import {
  classifyPortalPageTextForSession,
  classifyPortalUrlForSession,
  inspectPortalHtmlForAutoApply,
} from "./application-browser";

describe("portal auto-apply safety inspection", () => {
  it("classifies LinkedIn and generic authentication walls before submit", () => {
    expect(
      classifyPortalUrlForSession(
        "https://www.linkedin.com/signup/cold-join?session_redirect=https%3A%2F%2Fnl.linkedin.com%2Fjobs%2Fview%2F123",
      ),
    ).toMatchObject({ type: "needs_portal_session", provider: "linkedin" });

    expect(
      classifyPortalUrlForSession(
        "https://jobs.example.com/login?next=/apply/1",
      ),
    ).toMatchObject({ type: "needs_portal_session", provider: "generic" });
  });

  it("classifies sign-in page text as a portal-session gate", () => {
    expect(
      classifyPortalPageTextForSession({
        url: "https://jobs.example.com/apply",
        text: "Sign in to continue your application. Create account or log in.",
        hasPasswordField: true,
        hasApplicationFormSignal: false,
      }),
    ).toMatchObject({ type: "needs_portal_session" });
  });

  it("detects CAPTCHA and required-field pages without treating them as success", () => {
    const inspection = inspectPortalHtmlForAutoApply(`
      <form>
        <input name="email" type="email" required>
        <input name="resume" type="file" required>
        <div class="g-recaptcha" data-sitekey="site-key"></div>
        <button type="submit">Submit application</button>
      </form>
    `);

    expect(inspection.captchaRequired).toBe(true);
    expect(inspection.hasApplicationFormSignal).toBe(true);
    expect(inspection.requiredIssueCount).toBeGreaterThanOrEqual(2);
    expect(inspection.hasSuccessSignal).toBe(false);
  });

  it("recognizes success and no-success-signal HTML states separately", () => {
    expect(
      inspectPortalHtmlForAutoApply(
        "<main>Thank you for applying. Application received.</main>",
      ).hasSuccessSignal,
    ).toBe(true);
    expect(
      inspectPortalHtmlForAutoApply(
        "<main>Please review your profile and continue.</main>",
      ).hasSuccessSignal,
    ).toBe(false);
  });
});
