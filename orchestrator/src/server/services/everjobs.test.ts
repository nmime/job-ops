import { describe, expect, it, vi } from "vitest";
import { mapEverJobsJob, resolveEverJobsConfig, runEverJobs } from "./everjobs";

describe("Ever Jobs service", () => {
  it("normalizes the API key header and falls back on invalid names", () => {
    expect(resolveEverJobsConfig({}).apiKeyHeader).toBe("x-api-key");
    expect(
      resolveEverJobsConfig({ EVER_JOBS_API_KEY_HEADER: " Authorization " })
        .apiKeyHeader,
    ).toBe("Authorization");
    expect(
      resolveEverJobsConfig({ EVER_JOBS_API_KEY_HEADER: "X-Ever-Jobs-Key" })
        .apiKeyHeader,
    ).toBe("X-Ever-Jobs-Key");

    for (const invalidHeader of ["", "bad header", "x:key", "name,value"]) {
      expect(
        resolveEverJobsConfig({ EVER_JOBS_API_KEY_HEADER: invalidHeader })
          .apiKeyHeader,
      ).toBe("x-api-key");
    }
  });

  it("uses the configured API key header and selected country in requests", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: "ever-1",
              title: "Senior Engineer",
              jobUrl: "https://jobs.example/ever-1",
              company: { name: "Acme" },
              location: "Bengaluru",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runEverJobs({
      env: {
        EVER_JOBS_ENABLED: "true",
        EVER_JOBS_API_URL: "https://everjobs.example",
        EVER_JOBS_API_KEY: "test-key",
        EVER_JOBS_API_KEY_HEADER: "Authorization",
        EVER_JOBS_MAX_JOBS_PER_TERM: "10",
        EVER_JOBS_MIN_DELAY_MS: "0",
      },
      searchTerms: ["engineer"],
      selectedCountry: "India",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.locationEvidence?.country).toBe("india");

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall?.[0]).toBe(
      "https://everjobs.example/api/jobs/search?dedup=true&paginate=true&page=1&page_size=10",
    );
    const requestInit = fetchCall?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toMatchObject({ Authorization: "test-key" });
    expect(requestInit.headers).not.toMatchObject({ "x-api-key": "test-key" });

    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      searchTerm: "engineer",
      resultsWanted: 10,
      country: "India",
      location: "India",
    });
  });

  it("falls back to x-api-key when the configured header is invalid", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await runEverJobs({
      env: {
        EVER_JOBS_ENABLED: "true",
        EVER_JOBS_API_URL: "https://everjobs.example",
        EVER_JOBS_API_KEY: "test-key",
        EVER_JOBS_API_KEY_HEADER: "bad header",
      },
      searchTerms: ["engineer"],
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.headers).toMatchObject({ "x-api-key": "test-key" });
  });

  it("adds selected country evidence when mapping source jobs", () => {
    const mapped = mapEverJobsJob(
      {
        title: "Product Designer",
        job_url: "https://jobs.example/design",
        employer: "Design Co",
        location: "Remote",
        remote: true,
      },
      { selectedCountry: "United Kingdom" },
    );

    expect(mapped?.locationEvidence?.country).toBe("united kingdom");
    expect(mapped?.locationEvidence?.source).toBe("everjobs");
  });
});
