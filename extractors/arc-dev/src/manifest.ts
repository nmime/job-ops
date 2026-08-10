import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findArcDevGigs, applyToArcDevGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "arc-dev",
  displayName: "Arc.dev",
  kind: "talent-network",
  providesSources: ["arc-dev"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findArcDevGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToArcDevGig(ctx);
  },
};

export default manifest;
