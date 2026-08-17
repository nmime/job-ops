import { describe, expect, it } from "vitest";
import {
  extractLinks,
  findFreelancerResetLink,
  findFreelancerVerifyLink,
  findLink,
  queryParam,
} from "./email-links";

// Shapes taken from real Freelancer.com emails (2026-08-17).
const WELCOME_EMAIL = [
  "Welcome to Freelancer.com",
  "",
  "Hi NMI,",
  "Verify Your Email (https://www.freelancer.com/users/login-quick.php?token=c4c6307c5ee86b1bdc969ccc923269b43704fab52b456b7299e9c84d7e5b0b53&url=%2Fusers%2Fonverify.php%3Fid%3D94340619%26verifycode%3DODsFHcAC9dQyBS6N%26goto%3DZmExYzAxMWE4NDY0NDE1NzY1OTg1ZWU4NjEzODUwMjEvbmV3LWZyZWVsYW5jZXIvZW1haWwtdmVyaWZpY2F0aW9u&user_id=94340619&expire_at=1792134002&uniqid=94340619-36760-6a82b172-66966c0a)",
  "",
  "Update Your Profile (https://www.freelancer.com/users/login-quick.php?token=3767bcb653cc1054d2d4c7b7caa4c19954fac62c7cedcff543846cb4090d9e83&url=%2Fme%2F&user_id=94340619&expire_at=1792134002)",
].join("\n");

const RESET_EMAIL = [
  "Reset your Freelancer.com password",
  "Reset password now (https://www.freelancer.com/users/reset_user_password.php?token=b77b8940fe852252faadae119725ed50ac35b81f1069ad1a229034b20ec6dd80&userid=94340619&uniqid=94340619-412184-6a82dc05-29e28306)",
  "Privacy Policy (https://www.freelancer.com/page.php?p=info%2Fprivacy)",
].join("\n");

describe("email-links", () => {
  it("extracts labeled and bare links, de-duplicated in order", () => {
    const links = extractLinks(WELCOME_EMAIL);
    expect(links.length).toBe(2);
    expect(links[0].url).toContain("login-quick.php?token=c4c6307c");
    expect(links[1].url).toContain("url=%2Fme%2F");
  });

  it("finds the freelancer verify link (login-quick + onverify)", () => {
    const url = findFreelancerVerifyLink(WELCOME_EMAIL);
    expect(url).not.toBeNull();
    expect(url).toContain("onverify");
    // The profile-update link also uses login-quick but lacks onverify.
    expect(url).not.toContain("url=%2Fme%2F");
  });

  it("finds the freelancer reset link", () => {
    const url = findFreelancerResetLink(RESET_EMAIL);
    expect(url).toContain("reset_user_password.php");
    expect(url).toContain("userid=94340619");
  });

  it("returns null when no link matches all needles", () => {
    expect(findFreelancerVerifyLink(RESET_EMAIL)).toBeNull();
    expect(findLink("no links here", "x")).toBeNull();
  });

  it("reads query params including URL-encoded values", () => {
    const url = findFreelancerResetLink(RESET_EMAIL);
    expect(url).not.toBeNull();
    expect(queryParam(url ?? "", "token")).toBe(
      "b77b8940fe852252faadae119725ed50ac35b81f1069ad1a229034b20ec6dd80",
    );
    expect(queryParam(url ?? "", "userid")).toBe("94340619");
    expect(queryParam(url ?? "", "missing")).toBeNull();
    expect(queryParam("https://x.y/a", "b")).toBeNull();
  });
});
