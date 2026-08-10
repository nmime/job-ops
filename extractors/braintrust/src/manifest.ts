import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findBraintrustGigs, applyToBraintrustGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "braintrust",
  displayName: "Braintrust",
  kind: "talent-network",
  providesSources: ["braintrust"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findBraintrustGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToBraintrustGig(ctx);
  },
};

export default manifest;
