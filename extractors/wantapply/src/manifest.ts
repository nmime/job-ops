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
  // Real discovery via the public /api/jobs feed (Cloudflare-gated with a
  // stealth-browser fallback); apply is external (employer ATS) and guarded;
  // batch export to an auto-applier webhook is optional.
  kind: "remote-job-board",
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
