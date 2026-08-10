import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findGunIoGigs, applyToGunIoGig } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<ExtractorManifest, "providesSources" | "requiredEnvVars" | "capabilities"> = {
  id: "gun-io",
  displayName: "Gun.io",
  kind: "talent-network",
  providesSources: ["gun-io"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findGunIoGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToGunIoGig(ctx);
  },
};

export default manifest;
