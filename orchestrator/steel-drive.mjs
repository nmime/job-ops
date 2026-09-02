// steel-drive.mjs — attach to a persistent steel-browser session via CDP and run a task.
// This is the job-ops multi-platform browser layer: the steel session PERSISTS (timeout:0),
// so login state / cookies survive across invocations — the browser stays logged in.
//
// usage:
//   node steel-drive.mjs connect                      -> print the session's CDP info
//   node steel-drive.mjs run <task.mjs> [jsonArg]     -> run a task module
//
// A task module exports:  export default async function run(page, ctx, arg) { ... ; return result; }
//   ctx = { browser, page, sleep(ms), fetchJson(url, opts) }
// Network capture inside a task:  const net = ctx.net(); ...do things...; console.log(ctx.netList(net))
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , cmd, ...rest] = process.argv;

async function browserWs() {
  const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  return ver.webSocketDebuggerUrl;
}

const _net = new Map(); // sessionId -> requests
function netOn(page) {
  const id = Symbol("net");
  const list = [];
  _net.set(id, list);
  const handler = (req) => {
    const e = { method: req.method(), url: req.url(), type: req.resourceType() };
    list.push(e);
    Promise.resolve(req.response()).then((r) => { if (r) e.status = r.status(); }).catch(() => {});
  };
  page.on("request", handler);
  page.on("response", async (res) => {
    const e = list.find((x) => x.url === res.url() && x.status === undefined);
    if (e) e.status = res.status();
  });
  return { id, off: () => page.off("request", handler) };
}

if (cmd === "connect") {
  const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = targets.find((t) => t.type === "page");
  console.log(JSON.stringify({ browserWs: ver.webSocketDebuggerUrl, pageId: page?.id, pageUrl: page?.url }, null, 1));
} else if (cmd === "run") {
  const file = rest[0];
  const arg = rest[1] ? JSON.parse(rest[1]) : undefined;
  const browser = await puppeteer.connect({ browserWSEndpoint: await browserWs(), defaultViewport: null });
  const page = browser.pages()[0] || (await browser.newPage());
  const ctx = {
    browser, page,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchJson: async (url, opts) => (await (await fetch(url, opts)).json()),
    net: (p) => netOn(p || page),
    netList: (handle) => _net.get(handle.id) || [],
  };
  const mod = await import(pathToFileURL(file.startsWith("/") ? file : "/app/" + file).href);
  const fn = mod.run || mod.default;
  if (typeof fn !== "function") throw new Error("task must export run() or default");
  const out = await fn(page, ctx, arg);
  if (out !== undefined) console.log("RESULT " + JSON.stringify(out));
  browser.disconnect(); // session (browser) PERSISTS; only this CDP client detaches
} else {
  console.error("usage: steel-drive.mjs connect | run <task.mjs> [jsonArg]");
  process.exit(2);
}
