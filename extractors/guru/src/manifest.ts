import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToGuruGig, findGuruGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "guru",
  displayName: "Guru",
  kind: "freelance-marketplace",
  providesSources: ["guru"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findGuruGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToGuruGig(ctx);
  },
};

export default manifest;
