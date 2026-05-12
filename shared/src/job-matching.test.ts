import { describe, expect, it } from "vitest";
import { matchJobLocationIntent } from "./job-matching";

const remoteWorldwideIntent = {
  selectedCountry: "uzbekistan",
  country: "uzbekistan",
  cityLocations: [],
  workplaceTypes: ["remote"],
  geoScope: "selected_plus_remote_worldwide",
  searchScope: "selected_plus_remote_worldwide",
  matchStrictness: "flexible",
} as const;

describe("matchJobLocationIntent", () => {
  it("matches remote worldwide jobs from normalized location evidence", () => {
    expect(
      matchJobLocationIntent(
        {
          location: "Worldwide",
          isRemote: false,
          locationEvidence: {
            location: "Worldwide",
            workplaceType: "remote",
            isRemote: true,
          },
        },
        remoteWorldwideIntent,
      ),
    ).toEqual({
      matched: true,
      reasonCode: "remote_worldwide",
      priority: 0,
    });
  });

  it("infers remote worldwide from location candidates", () => {
    expect(
      matchJobLocationIntent(
        {
          location: "Anywhere",
          isRemote: false,
        },
        remoteWorldwideIntent,
      ),
    ).toEqual({
      matched: true,
      reasonCode: "remote_worldwide",
      priority: 0,
    });
  });

  it("does not use remote evidence when worldwide remote scope is disabled", () => {
    expect(
      matchJobLocationIntent(
        {
          location: "Anywhere",
          isRemote: false,
          locationEvidence: {
            location: "Anywhere",
            workplaceType: "remote",
            isRemote: true,
          },
        },
        {
          ...remoteWorldwideIntent,
          geoScope: "selected_only",
          searchScope: "selected_only",
        },
      ),
    ).toEqual({ matched: false, reasonCode: "no_match", priority: 0 });
  });
});
