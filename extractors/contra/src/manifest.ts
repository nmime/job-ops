import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findContraGigs, applyToContraGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "contra",
  displayName: "Contra",
  kind: "freelance-marketplace",
  providesSources: ["contra"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findContraGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToContraGig(ctx);
  },
};

export default manifest;
