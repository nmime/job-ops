import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToMaltGig, findMaltGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "malt",
  displayName: "Malt",
  kind: "freelance-marketplace",
  providesSources: ["malt"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findMaltGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToMaltGig(ctx);
  },
};

export default manifest;
