import type { ExtractorManifest } from "job-ops-shared/types/extractors";
import type { FreelanceProviderManifest } from "job-ops-shared/types/freelance";
import { findRemoteOkGigs } from "./main";

export const manifest: FreelanceProviderManifest &
  Pick<
    ExtractorManifest,
    "providesSources" | "requiredEnvVars" | "capabilities"
  > = {
  id: "remoteok",
  displayName: "RemoteOK",
  kind: "remote-job-board",
  providesSources: ["remoteok"],
  requiredEnvVars: [],
  capabilities: {},
  findGigs(ctx) {
    return findRemoteOkGigs(ctx);
  },
};

export default manifest;
