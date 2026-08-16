import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Freelance earnings routes", () => {
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

  function postEarnings(
    body: Record<string, unknown>,
    requestId = "req-earnings",
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/freelance/earnings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(body),
    });
  }

  it("records a pending earning and reflects it in stats + ledger", async () => {
    const res = await postEarnings({ platform: "upwork", amount: 250 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.earning).toMatchObject({
      platform: "upwork",
      amount: 250,
      currency: "USD",
      status: "pending",
    });
    expect(typeof body.data.earning.id).toBe("string");

    const statsRes = await fetch(`${baseUrl}/api/freelance/stats`);
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json();
    expect(stats.data.earnings.totalPending).toBe(250);
    expect(stats.data.earnings.totalPaid).toBe(0);
    expect(stats.data.earnings.byPlatform.upwork).toBe(250);

    const listRes = await fetch(`${baseUrl}/api/freelance/earnings`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.data.count).toBe(1);
    expect(list.data.earnings[0]).toMatchObject({
      platform: "upwork",
      amount: 250,
      status: "pending",
    });
  });

  it("counts paid entries toward totalPaid", async () => {
    await postEarnings({ platform: "fiverr", amount: 100, status: "paid" });
    const statsRes = await fetch(`${baseUrl}/api/freelance/stats`);
    const stats = await statsRes.json();
    expect(stats.data.earnings.totalPaid).toBe(100);
    expect(stats.data.earnings.totalPending).toBe(0);
  });

  it("rejects a missing platform with 400 INVALID_REQUEST", async () => {
    const res = await postEarnings({ amount: 50 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects an unknown platform with 400", async () => {
    const res = await postEarnings({ platform: "not-a-platform", amount: 50 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects non-positive or non-numeric amounts with 400", async () => {
    for (const amount of [0, -5, "abc"]) {
      const res = await postEarnings({ platform: "upwork", amount });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("rejects an invalid status with 400", async () => {
    const res = await postEarnings({
      platform: "upwork",
      amount: 50,
      status: "exploded",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("rejects an unknown gigId with an error response", async () => {
    const res = await postEarnings({
      platform: "upwork",
      amount: 50,
      gigId: "no-such-gig",
    });
    expect(res.status).not.toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
