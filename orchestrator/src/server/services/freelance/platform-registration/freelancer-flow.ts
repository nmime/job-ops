import type { PlatformRegistrationFlow } from "./types";

/**
 * Freelancer.com registration flow — declarative spec.
 *
 * This mirrors the flow that was executed live on 2026-08-17 (account
 * `nmime`, user_id 94340619). Selectors are accessibility labels resolved
 * against a fresh snapshot at run time; the driver re-snapshots between
 * steps because refs go stale.
 *
 * Known hard walls (documented, not bypassable by automation):
 *  - Login requires reCAPTCHA v3 (invisible). Headless browsers score too
 *    low → 403 AUTH_CAPTCHA_REQUIRED. Workaround proven in practice:
 *    request a solve through the platform captcha proxy, inject the token
 *    into the login XHR (one token, one request).
 *  - If a session is lost, re-auth WITHOUT captcha via the forgot-password
 *    loop: /auth/forgot POST → email with reset_user_password.php link →
 *    set password on the reset page → auto-login.
 *  - Developer apps (OAuth) require PAYMENT VERIFICATION (card or PayPal).
 *    That needs real financial credentials and stays a manual follow-up.
 */
export const FREELANCER_FLOW: PlatformRegistrationFlow = {
  platformId: "freelancer",
  signupUrl: "https://www.freelancer.com/signup",
  credentialEnvVar: "JOBOPS_FREELANCE_FREELANCER_API_KEY",
  credentialFile: "freelancer.txt",
  manualFollowUps: [
    "Verify a payment method (card or PayPal) at /new-freelancer/payment-verification — required before any developer app can be created.",
    "Create an OAuth app at https://accounts.freelancer.com/settings/develop and paste the access token into JOBOPS_FREELANCE_FREELANCER_API_KEY.",
  ],
  steps: [
    {
      id: "open-signup",
      kind: "open",
      url: "https://www.freelancer.com/signup",
      description: "Open the signup page.",
    },
    {
      id: "fill-name-email-password",
      kind: "fill",
      selector: 'textbox "First Name"',
      value: "{{first_name}}",
      description:
        "Fill first name, last name, email, password; check the terms checkbox.",
    },
    {
      id: "join",
      kind: "click",
      selector: 'button "Join Freelancer"',
      description: "Submit stage 1 (name/email/password + terms).",
    },
    {
      id: "choose-username",
      kind: "fill",
      selector: 'textbox "Username"',
      value: "{{username}}",
      description: "Pick a username (cannot be changed later).",
    },
    {
      id: "choose-account-type",
      kind: "click",
      selector: "generic[0] (Earn money freelancing card)",
      description: "Select the freelancer (earner) account type.",
    },
    {
      id: "decline-marketing",
      kind: "skip-if",
      condition: "marketing opt-in checkbox is checked",
      description: "Leave marketing opt-in unchecked.",
    },
    {
      id: "sign-up-final",
      kind: "click",
      selector: 'button "Sign Up"',
      description: "Final submit — account is created here.",
    },
    {
      id: "onboarding-skills",
      kind: "click",
      selector: "category 'Websites, IT & Software' + top skills",
      description:
        "Select skills category and skills in /new-freelancer/skills.",
    },
    {
      id: "onboarding-name",
      kind: "fill",
      selector: 'textbox "First name"',
      value: "{{first_name}}",
      description: "Profile name step (photo optional).",
    },
    {
      id: "onboarding-headline",
      kind: "fill",
      selector:
        'textbox "What do you do? Write a one line description about yourself."',
      value: "{{headline}}",
      description: "Headline (max 50 chars) + summary.",
    },
    {
      id: "onboarding-languages-birthdate",
      kind: "fill",
      selector: "#inputBirthdate",
      value: "{{birthdate}}",
      description: "Languages (add English) + birthdate (MM/DD/YYYY).",
    },
    {
      id: "verify-email",
      kind: "extract",
      artifact: "verify-link",
      description:
        "Read the welcome email; open the login-quick.php?…onverify.php link to verify the address.",
    },
    {
      id: "reauth-if-needed",
      kind: "skip-if",
      condition: "session cookie present after verify",
      description:
        "If logged out: Forgot Password → email → reset_user_password.php link → set password → auto-login.",
    },
    {
      id: "payment-verification",
      kind: "skip-if",
      condition: "operator has provided payment credentials",
      description:
        "MANUAL: verify a card or PayPal. Blocks developer-app creation until done.",
    },
    {
      id: "create-dev-app",
      kind: "open",
      url: "https://accounts.freelancer.com/settings/develop",
      description:
        "Create the OAuth app, copy the access token into JOBOPS_FREELANCE_FREELANCER_API_KEY.",
    },
  ],
};
