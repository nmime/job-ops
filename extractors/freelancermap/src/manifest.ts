import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findFreelancermapGigs, applyToFreelancermapGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "freelancermap",
  displayName: "freelancermap (DE)",
  kind: "freelance-marketplace",
  providesSources: ["freelancermap"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findFreelancermapGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToFreelancermapGig(ctx);
  },
};

export default manifest;
