import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findUpworkGigs, applyToUpworkGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "upwork",
  displayName: "Upwork",
  kind: "freelance-marketplace",
  providesSources: ["upwork"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findUpworkGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToUpworkGig(ctx);
  },
};

export default manifest;
