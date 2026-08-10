import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import {
  applyToWantapplyGig,
  exportBatchToWantapply,
  findWantapplyGigs,
} from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "wantapply",
  displayName: "Wantapply",
  kind: "auto-apply-exporter",
  providesSources: ["wantapply"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findWantapplyGigs(ctx);
  },
  applyToGig(ctx) {
    return applyToWantapplyGig(ctx);
  },
  exportBatch(ctx) {
    return exportBatchToWantapply(ctx);
  },
};

export default manifest;
