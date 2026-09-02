// kwork discover.mjs — ensure logged in (seed profile), fetch existing kworks, report phone gate.
import { readFileSync } from "node:fs";
export default async function run(page, ctx, arg) {
  const sleep = ctx.sleep;
  const m = arg?.manifest || {};
  async function go(url) { try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch {} await sleep(4500); }
  // load password from /app/kwork.env (copied by run.sh) as a fallback for env
  let password = process.env.KW_PASSWORD || "";
  try {
    const env = readFileSync("/app/kwork.env", "utf8");
    const mm = env.match(/KW_PASSWORD=([^\n]+)/);
    if (mm) password = mm[1].trim();
  } catch {}
  await go("https://kwork.com/seller");
  let st = await page.evaluate(() => ({ url: location.href, isUserWorker: window.isUserWorker, phone: window.actorPhoneVerified })).catch(() => ({}));
  const loggedIn = /seller|manage_kworks/.test(st.url || "");
  if (!loggedIn && password) {
    // attempt login using manifest credentials
    await go(m.login?.url || "https://kwork.com/settings");
    const email = await page.$("input[placeholder*=mail i]") || await page.$("input[name=username]");
    const pass = await page.$("input[type=password]");
    if (email && pass) {
      const el = (email && email.asElement && email.asElement()) || email;
      const pl = (pass && pass.asElement && pass.asElement()) || pass;
      await el.click(); await page.keyboard.type(m.login?.email || "", { delay: 20 });
      await pl.click(); await page.keyboard.type(password, { delay: 20 });
      await sleep(500);
      const btn = await page.evaluateHandle(() => document.querySelector("button[type=submit]") || [...document.querySelectorAll("button")].find((b) => /sign ?in/i.test(b.textContent || "")));
      const bel = btn.asElement && btn.asElement(); if (bel) await bel.click().catch(() => {});
      await sleep(7000);
      await go("https://kwork.com/seller");
      st = await page.evaluate(() => ({ url: location.href, isUserWorker: window.isUserWorker, phone: window.actorPhoneVerified })).catch(() => ({}));
    }
  }
  const isLogged = /seller|manage_kworks/.test(st.url || "");
  // fetch existing kworks
  let kworks = [];
  if (isLogged) {
    await go("https://kwork.com/manage_kworks");
    kworks = await page.evaluate(() => [...document.querySelectorAll("a[href*='kwork']")].map((e) => ({ title: (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90), url: e.href })).filter((x) => x.title && /kwork\//i.test(x.url || "")).slice(0, 25)).catch(() => []);
  }
  const phoneVerified = st.phone === true;
  const blocked = isLogged && !phoneVerified ? ["phone-verification-voice-call"] : [];
  return {
    login: { logged_in: isLogged, is_user_worker: !!st.isUserWorker, phone_verified: phoneVerified },
    blocked,
    opportunities: (kworks || []).map((k) => ({ external_id: (k.url || "").split("/").pop() || k.title, title: k.title, opportunity_url: k.url, status: "posted", score: 0, reason: "existing-kwork" })),
  };
}
