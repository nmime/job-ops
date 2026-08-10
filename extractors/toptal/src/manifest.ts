import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findToptalGigs, applyToToptalGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "toptal",
  displayName: "Toptal",
  kind: "talent-network",
  providesSources: ["toptal"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findToptalGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToToptalGig(ctx);
  },
};

export default manifest;
