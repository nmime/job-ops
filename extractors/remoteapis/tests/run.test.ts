import { describe, expect, it, vi } from "vitest";
import { runRemoteApiJobs } from "../src/run";

function createJsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function createTextResponse(payload: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => payload,
  } as Response;
}

describe("runRemoteApiJobs", () => {
  it("maps Remotive and Jobicy jobs and filters by search term", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("remotive")) {
        return Promise.resolve(
          createJsonResponse({
            jobs: [
              {
                id: 1,
                title: "Senior Backend Engineer",
                company_name: "Acme",
                url: "https://remotive.com/jobs/1",
                candidate_required_location: "Worldwide",
                publication_date: "2026-05-01",
                job_type: "full_time",
                category: "Software Development",
                tags: ["typescript", "node"],
                description: "Build APIs",
              },
            ],
          }),
        );
      }

      return Promise.resolve(
        createJsonResponse({
          jobs: [
            {
              id: 2,
              jobTitle: "Product Designer",
              companyName: "Beta",
              url: "https://jobicy.com/jobs/2",
              jobGeo: "Europe",
              jobIndustry: "Design",
              jobTags: ["figma"],
            },
          ],
        }),
      );
    });

    const result = await runRemoteApiJobs({
      selectedSources: ["remotive", "jobicy"],
      searchTerms: ["backend engineer"],
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(
      expect.objectContaining({
        source: "remotive",
        title: "Senior Backend Engineer",
        employer: "Acme",
        isRemote: true,
      }),
    );
  });

  it("parses We Work Remotely RSS jobs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createTextResponse(`
        <rss><channel><item>
          <title><![CDATA[Acme is hiring a Full Stack Engineer]]></title>
          <link>https://weworkremotely.com/remote-jobs/acme-engineer</link>
          <description><![CDATA[React and TypeScript role]]></description>
          <pubDate>Mon, 11 May 2026 10:00:00 GMT</pubDate>
          <category>Programming</category>
        </item></channel></rss>
      `),
    );

    const result = await runRemoteApiJobs({
      selectedSources: ["weworkremotely"],
      searchTerms: ["typescript"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([
      expect.objectContaining({
        source: "weworkremotely",
        title: "Full Stack Engineer",
        employer: "Acme",
        jobUrl: "https://weworkremotely.com/remote-jobs/acme-engineer",
      }),
    ]);
  });
});
