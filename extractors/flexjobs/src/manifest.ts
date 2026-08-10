import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToFlexjobsGig, findFlexjobsGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "flexjobs",
  displayName: "FlexJobs",
  kind: "remote-job-board",
  providesSources: ["flexjobs"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findFlexjobsGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToFlexjobsGig(ctx);
  },
};

export default manifest;
