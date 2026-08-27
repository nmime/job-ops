import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToWwrGig, findWwrGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "weworkremotely",
  displayName: "We Work Remotely",
  kind: "remote-job-board",
  providesSources: ["weworkremotely"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findWwrGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToWwrGig(ctx);
  },
};

export default manifest;
