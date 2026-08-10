import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToFreelancerGig, findFreelancerGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "freelancer",
  displayName: "Freelancer.com",
  kind: "freelance-marketplace",
  providesSources: ["freelancer"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findFreelancerGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToFreelancerGig(ctx);
  },
};

export default manifest;
