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

  it("maps Remote OK API jobs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse([
        { legal: "terms" },
        {
          id: "remoteok-1",
          position: "Platform Engineer",
          company: "Remote Co",
          url: "https://remoteok.com/remote-jobs/remoteok-1",
          apply_url: "mailto:jobs@remote.co",
          location: "Worldwide",
          description: "Kubernetes and TypeScript",
          tags: ["kubernetes", "typescript"],
          salary_min: 120000,
          salary_max: 160000,
          salary_currency: "USD",
        },
      ]),
    );

    const result = await runRemoteApiJobs({
      selectedSources: ["remoteok"],
      searchTerms: ["platform engineer"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([
      expect.objectContaining({
        source: "remoteok",
        title: "Platform Engineer",
        employer: "Remote Co",
        applicationLink: "mailto:jobs@remote.co",
        salary: "USD120000 - USD160000",
      }),
    ]);
  });

  it("maps configured public board API jobs", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("greenhouse.io")) {
        return Promise.resolve(
          createJsonResponse({
            jobs: [
              {
                id: 101,
                title: "Backend Engineer",
                company_name: "Green Co",
                absolute_url: "https://boards.greenhouse.io/green/jobs/101",
                location: { name: "Remote - US" },
                content: "Build backend services",
                departments: [{ name: "Engineering" }],
              },
            ],
          }),
        );
      }

      if (url.includes("api.lever.co")) {
        return Promise.resolve(
          createJsonResponse([
            {
              id: "lever-1",
              text: "Backend Engineer",
              hostedUrl: "https://jobs.lever.co/acme/lever-1",
              applyUrl: "https://jobs.lever.co/acme/lever-1/apply",
              categories: {
                location: "Remote",
                team: "Engineering",
                commitment: "Full-time",
              },
              descriptionPlain: "Backend APIs",
            },
          ]),
        );
      }

      if (url.includes("ashbyhq.com")) {
        return Promise.resolve(
          createJsonResponse({
            jobs: [
              {
                id: "ashby-1",
                title: "Backend Engineer",
                jobUrl: "https://jobs.ashbyhq.com/acme/ashby-1",
                location: "Remote",
                department: "Engineering",
                descriptionPlain: "Backend platform role",
                compensation: { compensationTierSummary: "$100k - $140k" },
              },
            ],
          }),
        );
      }

      return Promise.resolve(
        createJsonResponse({
          content: [
            {
              id: "smart-1",
              name: "Backend Engineer",
              company: { name: "Smart Co" },
              postingUrl: "https://jobs.smartrecruiters.com/acme/smart-1",
              location: { city: "Remote" },
              jobAd: { sections: { jobDescription: "Backend systems" } },
            },
          ],
        }),
      );
    });

    const result = await runRemoteApiJobs({
      selectedSources: ["greenhouse", "lever", "ashby", "smartrecruiters"],
      searchTerms: ["backend engineer"],
      greenhouseBoardTokens: ["green"],
      leverSites: ["acme"],
      ashbyJobBoardNames: ["acme"],
      smartrecruitersCompanies: ["acme"],
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.source)).toEqual([
      "greenhouse",
      "lever",
      "ashby",
      "smartrecruiters",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://boards-api.greenhouse.io/v1/boards/green/jobs",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.lever.co/v0/postings/acme?mode=json",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100",
      expect.any(Object),
    );
  });

  it("scrapes Telegram public channel HTML and filters by search term", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createTextResponse(`
        <section>
          <div class="tgme_widget_message" data-post="nodejsjobsfeed/42">
            <div class="tgme_widget_message_text">
              Node.js Backend Engineer<br/>Remote friendly<br/>
              <a href="https://example.com/apply">Apply now</a>
            </div>
            <a class="tgme_widget_message_date" href="https://t.me/nodejsjobsfeed/42"></a>
          </div>
        </section>
      `),
    );

    const result = await runRemoteApiJobs({
      selectedSources: ["telegram"],
      searchTerms: ["node backend"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://t.me/s/nodejsjobsfeed",
      expect.any(Object),
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({
        source: "telegram",
        employer: "nodejsjobsfeed",
        applicationLink: "https://example.com/apply",
        sourceJobId: "nodejsjobsfeed/42",
      }),
    ]);
  });

  it("maps Himalayas browse API jobs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        jobs: [
          {
            guid: "https://himalayas.app/jobs/acme-platform",
            title: "Remote Platform Engineer",
            companyName: "Himalaya Co",
            applicationLink: "https://himalayas.app/jobs/acme-platform/apply",
            pubDate: "2026-05-10T00:00:00.000Z",
            excerpt: "TypeScript platform work",
            locationRestrictions: ["Worldwide"],
            categories: ["Engineering"],
            salary: "$120k - $150k",
          },
        ],
      }),
    );

    const result = await runRemoteApiJobs({
      selectedSources: ["himalayas"],
      searchTerms: ["platform engineer"],
      himalayasPages: 1,
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://himalayas.app/jobs/api?limit=20&offset=0",
      expect.any(Object),
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({
        source: "himalayas",
        employer: "Himalaya Co",
        title: "Remote Platform Engineer",
        applicationLink: "https://himalayas.app/jobs/acme-platform/apply",
        location: "Worldwide",
        salary: "$120k - $150k",
      }),
    ]);
  });

  it("maps HN Who is Hiring top-level comments from Algolia APIs", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("search_by_date")) {
        return Promise.resolve(
          createJsonResponse({
            hits: [
              {
                objectID: "123",
                title: "Ask HN: Who is hiring? (May 2026)",
              },
            ],
          }),
        );
      }

      return Promise.resolve(
        createJsonResponse({
          id: 123,
          children: [
            {
              id: 456,
              author: "founder",
              created_at: "2026-05-01T00:00:00.000Z",
              text: "Acme | Backend Engineer | Remote<br/>We are hiring TypeScript engineers.",
            },
            { id: 457, author: "reply", text: "thanks" },
          ],
        }),
      );
    });

    const result = await runRemoteApiJobs({
      selectedSources: ["hnhiring"],
      searchTerms: ["backend engineer"],
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([
      expect.objectContaining({
        source: "hnhiring",
        sourceJobId: "456",
        employer: "Acme",
        title: "Backend Engineer",
        jobUrl: "https://news.ycombinator.com/item?id=456",
      }),
    ]);
  });

  it("skips USAJOBS without credentials and maps federal jobs with opt-in credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        SearchResult: {
          SearchResultItems: [
            {
              MatchedObjectDescriptor: {
                PositionID: "usa-1",
                PositionTitle: "Software Engineer",
                OrganizationName: "NASA",
                PositionURI: "https://www.usajobs.gov/job/usa-1",
                ApplyURI: "https://www.usajobs.gov/job/usa-1/apply",
                PublicationStartDate: "2026-05-02",
                PositionLocation: [{ LocationName: "Remote" }],
                UserArea: {
                  Details: { JobSummary: "Build federal platforms" },
                },
                PositionRemuneration: [
                  { MinimumRange: 100000, MaximumRange: 150000 },
                ],
              },
            },
          ],
        },
      }),
    );

    await expect(
      runRemoteApiJobs({
        selectedSources: ["usajobs"],
        searchTerms: ["software engineer"],
        fetchImpl: fetchMock,
      }),
    ).resolves.toMatchObject({ success: true, jobs: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await runRemoteApiJobs({
      selectedSources: ["usajobs"],
      searchTerms: ["software engineer"],
      usajobsApiKey: "secret-key",
      usajobsUserAgent: "dev@example.com",
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://data.usajobs.gov/api/Search?Keyword=software+engineer&ResultsPerPage=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          Host: "data.usajobs.gov",
          "User-Agent": "dev@example.com",
          "Authorization-Key": "secret-key",
        }),
      }),
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({
        source: "usajobs",
        sourceJobId: "usa-1",
        employer: "NASA",
        salary: "USD100000 - USD150000",
      }),
    ]);
  });
});
