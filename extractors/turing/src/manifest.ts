import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { applyToTuringGig, findTuringGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "turing",
  displayName: "Turing",
  kind: "talent-network",
  providesSources: ["turing"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findTuringGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToTuringGig(ctx);
  },
};

export default manifest;
