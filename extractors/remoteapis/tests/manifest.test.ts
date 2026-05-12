import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", async () => {
  const actual =
    await vi.importActual<typeof import("../src/run")>("../src/run");
  return {
    ...actual,
    runRemoteApiJobs: vi.fn(),
  };
});

describe("remoteapis manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards selected API sources and automatic-run settings to the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runRemoteApiJobs } = await import("../src/run");
    const runRemoteApiJobsMock = vi.mocked(runRemoteApiJobs);
    runRemoteApiJobsMock.mockResolvedValue({
      success: true,
      jobs: [],
    });

    await manifest.run({
      source: "remotive",
      selectedSources: ["remotive", "jobicy"],
      settings: {
        jobspyResultsWanted: "25",
        workplaceTypes: '["remote"]',
        searchCities: "Berlin",
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "germany",
    });

    expect(runRemoteApiJobsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSources: ["remotive", "jobicy"],
        maxJobsPerTerm: 25,
        workplaceTypes: ["remote"],
        locations: ["Berlin"],
        selectedCountry: "germany",
      }),
    );
  });
});
