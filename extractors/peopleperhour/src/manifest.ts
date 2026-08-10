import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findPeopleperhourGigs, applyToPeopleperhourGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "peopleperhour",
  displayName: "PeoplePerHour",
  kind: "freelance-marketplace",
  providesSources: ["peopleperhour"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findPeopleperhourGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToPeopleperhourGig(ctx);
  },
};

export default manifest;
