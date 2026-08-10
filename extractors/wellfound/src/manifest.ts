import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToWellfoundGig, findWellfoundGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "wellfound",
  displayName: "Wellfound (AngelList)",
  kind: "startup-job-board",
  providesSources: ["wellfound"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findWellfoundGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToWellfoundGig(ctx);
  },
};

export default manifest;
