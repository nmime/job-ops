// kwork apply.mjs — post a kwork (post model). Currently gated behind voice-call phone verification.
export default async function run(page, ctx, arg) {
  const sleep = ctx.sleep;
  async function go(url) { try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch {} await sleep(4500); }
  await go("https://kwork.com/manage_kworks");
  const phoneVerified = await page.evaluate(() => window.actorPhoneVerified === true).catch(() => false);
  if (!phoneVerified) {
    return { status: "blocked", detail: "phone-verification-voice-call: Kwork requires a voice-call phone verification before creating a kwork. Rental SMS numbers can't take a call and the provider doesn't list Kwork. Need a real number + a human to answer the call." };
  }
  // Phone verified: the create-kwork form (multi-step wizard) still needs to be reversed + driven.
  return { status: "failed", detail: "create-kwork wizard not yet reversed (phone verified, next: reverse /manage_kworks 'Create a Kwork' form + POST)" };
}
