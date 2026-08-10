import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToFiverrGig, findFiverrGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "fiverr",
  displayName: "Fiverr",
  kind: "gig-marketplace",
  providesSources: ["fiverr"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findFiverrGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToFiverrGig(ctx);
  },
};

export default manifest;
