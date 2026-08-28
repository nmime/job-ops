import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

const API = (baseUrl: string, path: string) => `${baseUrl}/api/freelance${path}`;

describe.sequential("Freelance profile campaign routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  async function postProfile(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(API(baseUrl, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }

  it("GET /profiles lists all 14 campaign platforms with field-level state", async () => {
    const res = await fetch(API(baseUrl, "/profiles"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(14);
    const ids = body.data.profiles.map((p: any) => p.platform);
    for (const id of [
      "upwork",
      "freelancer",
      "fiverr",
      "toptal",
      "turing",
      "arc-dev",
      "peopleperhour",
      "guru",
      "flexjobs",
      "malt",
      "wellfound",
      "braintrust",
      "contra",
      "weworkremotely",
    ]) {
      expect(ids).toContain(id);
    }
    const fiverr = body.data.profiles.find((p: any) => p.platform === "fiverr");
    expect(fiverr.backend).toBe("browser_mac");
    // Field-level state: standard fields + user-only lines, none autofilled.
    expect(fiverr.fields.gigs).toBeDefined();
    expect(fiverr.fields.dob.status).toBe("user_only");
    expect(fiverr.fields.phone.status).toBe("user_only");
    expect(fiverr.fields.face_photo.status).toBe("user_only");
    expect(fiverr.fields.street_address.status).toBe("user_only");
    expect(fiverr.fields.headline.status).toBe("pending");
    const wwr = body.data.profiles.find((p: any) => p.platform === "weworkremotely");
    expect(wwr.status).toBe("in_progress");
    expect(wwr.backend).toBe("none");
  });

  it("GET /profiles?platform filters and rejects unknown platforms", async () => {
    const res = await fetch(API(baseUrl, "/profiles?platform=upwork"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.count).toBe(1);
    expect(body.data.profiles[0].platform).toBe("upwork");

    const bad = await fetch(API(baseUrl, "/profiles?platform=bogus"));
    expect(bad.status).toBe(400);
  });

  it("POST /profiles/:platform/publish queues a pending mac step list (idempotent)", async () => {
    const first = await postProfile("/profiles/fiverr/publish");
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.data.result.status).toBe("pending");
    expect(first.body.data.result.backend).toBe("browser_mac");
    const actionId = first.body.data.result.actionId;
    expect(typeof actionId).toBe("number");

    // The step list is visible in GET /profiles.
    const listRes = await fetch(API(baseUrl, "/profiles?platform=fiverr"));
    const listed = (await listRes.json()).data.profiles[0];
    expect(listed.pendingSteps).toHaveLength(1);
    expect(listed.pendingSteps[0].kind).toBe("publish");
    expect(listed.pendingSteps[0].steps.length).toBeGreaterThan(0);

    // Re-run: the same pending action is reused, no duplicate step list.
    const second = await postProfile("/profiles/fiverr/publish");
    expect(second.body.data.result.actionId).toBe(actionId);
    const list2 = (await (await fetch(API(baseUrl, "/profiles?platform=fiverr"))).json()).data.profiles[0];
    expect(list2.pendingSteps).toHaveLength(1);
  });

  it("POST /profiles/:platform/complete for browser_mac queues the fill steps", async () => {
    const first = await postProfile("/profiles/fiverr/complete");
    expect(first.status).toBe(200);
    expect(first.body.data.result.status).toBe("pending");
    expect(first.body.data.result.actionId).toBeDefined();
  });

  it("POST /profiles/:platform/:action reports not-applicable where the action does not exist", async () => {
    const res = await postProfile("/profiles/braintrust/post");
    expect(res.status).toBe(200);
    expect(res.body.data.result.status).toBe("not-applicable");

    const none = await postProfile("/profiles/weworkremotely/complete");
    expect(none.status).toBe(200);
    expect(none.body.data.result.status).toBe("not-applicable");
    expect(none.body.data.result.notes[0]).toMatch(/not-applicable/i);
  });

  it("POST /profiles/:platform/record applies operator-reported results", async () => {
    const res = await postProfile("/profiles/contra/record", {
      completeness: "50%",
      status: "in_progress",
      fields: {
        skills: { status: "done", evidence: "operator: skill tags applied in UI" },
        work_history: { status: "pending", evidence: "not yet" },
      },
      content: [
        { kind: "post", title: "Work 5 — AI Agent Platform", status: "published" },
      ],
      note: "operator pass 2",
    });
    expect(res.status).toBe(200);
    const { profile, updated } = res.body.data;
    expect(profile.platform).toBe("contra");
    expect(profile.completeness).toBe("50%");
    expect(profile.fields.skills.status).toBe("done");
    expect(profile.fields.skills.verified_at).toBeTruthy();
    expect(profile.fields.work_history.status).toBe("pending");
    expect(updated.fields.skills).toBeTruthy();
    expect(profile.content.some((c: any) => c.title === "Work 5 — AI Agent Platform" && c.status === "published")).toBe(true);

    // Record again — content upsert is idempotent (no duplicates).
    await postProfile("/profiles/contra/record", {
      content: [{ kind: "post", title: "Work 5 — AI Agent Platform", status: "published" }],
    });
    const after = (await (await fetch(API(baseUrl, "/profiles?platform=contra"))).json()).data.profiles[0];
    expect(after.content.filter((c: any) => c.title === "Work 5 — AI Agent Platform")).toHaveLength(1);
  });

  it("POST /profiles/:platform/record with an empty body is a 400", async () => {
    const res = await postProfile("/profiles/contra/record", {});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("rejects unknown platforms and unknown actions with 400", async () => {
    const badPlatform = await postProfile("/profiles/bogus/publish");
    expect(badPlatform.status).toBe(400);

    const badAction = await postProfile("/profiles/fiverr/takeoff");
    expect(badAction.status).toBe(400);
  });
});
