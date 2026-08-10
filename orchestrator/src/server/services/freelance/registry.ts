import { logger } from "@infra/logger";
import {
  FREELANCE_PLATFORM_IDS,
  type FreelancePlatformId,
  type FreelanceProviderManifest,
} from "@shared/types/freelance";

export interface FreelanceProviderRegistry {
  manifests: Map<FreelancePlatformId, FreelanceProviderManifest>;
  availablePlatforms: FreelancePlatformId[];
  failed: Array<{ platform: FreelancePlatformId; error: string }>;
}

let cachedRegistry: FreelanceProviderRegistry | null = null;

/** Test seam: inject manifests instead of dynamic-importing packages. */
export function __setFreelanceRegistryForTests(
  registry: FreelanceProviderRegistry | null,
): void {
  cachedRegistry = registry;
}

async function loadManifest(
  id: FreelancePlatformId,
): Promise<{ manifest: FreelanceProviderManifest | null; error?: string }> {
  try {
    const mod = (await import(
      /* @vite-ignore */ `${id}-extractor/src/manifest.ts`
    )) as {
      manifest?: FreelanceProviderManifest;
      default?: FreelanceProviderManifest;
    };
    const manifest = mod.manifest ?? mod.default ?? null;
    if (!manifest) {
      return { manifest: null, error: "package exports no manifest" };
    }
    return { manifest };
  } catch (error) {
    return {
      manifest: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load every freelance provider manifest. Providers that fail to load are
 * recorded in `failed` rather than throwing, so one broken package never
 * takes the aggregator down.
 */
export async function getFreelanceProviderRegistry(): Promise<FreelanceProviderRegistry> {
  if (cachedRegistry) return cachedRegistry;

  const manifests = new Map<FreelancePlatformId, FreelanceProviderManifest>();
  const failed: Array<{ platform: FreelancePlatformId; error: string }> = [];

  const ids = FREELANCE_PLATFORM_IDS.filter((id) => id !== "aggregator-core");
  const loaded = await Promise.all(
    ids.map(async (id) => ({ id, ...(await loadManifest(id)) })),
  );

  for (const entry of loaded) {
    if (entry.manifest) {
      manifests.set(entry.id, entry.manifest);
    } else {
      failed.push({ platform: entry.id, error: entry.error ?? "unknown" });
    }
  }

  if (failed.length > 0) {
    logger.warn("Some freelance providers failed to load", { failed });
  }

  cachedRegistry = {
    manifests,
    availablePlatforms: [...manifests.keys()],
    failed,
  };
  return cachedRegistry;
}

export async function resolveFreelanceProvider(
  id: FreelancePlatformId,
): Promise<FreelanceProviderManifest> {
  const registry = await getFreelanceProviderRegistry();
  const manifest = registry.manifests.get(id);
  if (!manifest) {
    throw new Error(`Freelance provider "${id}" is not registered`);
  }
  return manifest;
}
