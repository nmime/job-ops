import { logger } from "@infra/logger";
import {
  type FreelanceApplyResult,
  type FreelancePlatformId,
} from "@shared/types/freelance";
import {
  type GigRow,
  saveProposal,
  updateGigStatus,
  upsertGig,
} from "@server/repositories/freelance";
import {
  type AggregatedGig,
  type AggregatorRunResult,
  isFreelanceAutobidEnabled,
  runAggregatorCycle,
} from "./aggregator";
import { applyToFreelanceGig } from "./apply-adapter";
import { computeDedupHash } from "./dedupe";

export interface WorkerCycleReport {
  cycle: number;
  startedAt: string;
  finishedAt: string;
  aggregate: Omit<AggregatorRunResult, "gigs">;
  persisted: { created: number; updated: number };
  topGigs: Array<{
    platform: FreelancePlatformId;
    title: string;
    clientOrEmployer: string;
    gigUrl: string;
    suitabilityScore: number | null;
  }>;
  applies: FreelanceApplyResult[];
  autobidEnabled: boolean;
  errors: string[];
}

export interface WorkerOptions {
  cycles?: number;
  intervalMs?: number;
  bidsPerCycle?: number;
  minScore?: number;
  searchTerms?: string[];
  profileSkills?: string[];
  platforms?: FreelancePlatformId[];
  onCycle?: (report: WorkerCycleReport) => void | Promise<void>;
  shouldStop?: () => boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run ONE autonomous freelance cycle:
 *   discover -> dedupe -> score -> pick top N -> draft/submit proposals.
 *
 * Submission is dry-run unless BOTH:
 *   - FREELANCE_AUTOBID_ENABLED=true            (global switch)
 *   - JOBOPS_FREELANCE_<PLATFORM>_APPLY_ENABLED=true  (per platform)
 *
 * In dry-run the proposals are still fully generated, so the operator can
 * inspect exactly what would have been sent.
 */
export async function runWorkerCycle(
  cycleNumber: number,
  options: WorkerOptions = {},
): Promise<WorkerCycleReport> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const autobidEnabled = isFreelanceAutobidEnabled();

  let result: AggregatorRunResult;
  try {
    result = await runAggregatorCycle({
      platforms: options.platforms,
      searchTerms: options.searchTerms,
      profileSkills: options.profileSkills,
      minScore: options.minScore,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`aggregator cycle failed: ${message}`);
    const finishedAt = new Date().toISOString();
    return {
      cycle: cycleNumber,
      startedAt,
      finishedAt,
      aggregate: {
        startedAt,
        finishedAt,
        discovered: 0,
        deduped: 0,
        scored: 0,
        enqueued: 0,
        perPlatform: [],
      },
      persisted: { created: 0, updated: 0 },
      topGigs: [],
      applies: [],
      autobidEnabled,
      errors,
    };
  }

  const { gigs, ...aggregate } = result;

  // Persist every scored gig so the dashboard, stats and ledger reflect the
  // unattended worker's work (same persistence contract as POST /run).
  const persisted = { created: 0, updated: 0 };
  const gigRows = new Map<string, GigRow>(); // dedupHash -> persisted row
  for (const gig of gigs) {
    try {
      const result = await upsertGig({
        ...gig,
        dedupHash: computeDedupHash(gig),
        suitabilityScore: gig.suitabilityScore ?? null,
      });
      if (result.created) persisted.created += 1;
      else persisted.updated += 1;
      gigRows.set(gig.dedupHash, result.gig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`persist failed for ${gig.platform}/${gig.title}: ${message}`);
    }
  }

  const bidsPerCycle = options.bidsPerCycle ?? 3;
  const targets: AggregatedGig[] = gigs.slice(0, bidsPerCycle);

  const applies: FreelanceApplyResult[] = [];
  for (const gig of targets) {
    if (options.shouldStop?.()) break;
    let applyResult: FreelanceApplyResult;
    try {
      applyResult = await applyToFreelanceGig({
        gigId: gig.dedupHash,
        platform: gig.platform,
        gigTitle: gig.title,
        gigDescription: gig.gigDescription ?? gig.title,
        profileSkills: options.profileSkills,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`apply failed for ${gig.platform}/${gig.title}: ${message}`);
      continue;
    }
    applies.push(applyResult);

    // Persist the proposal + advance gig status so the money path is fully
    // observable in the UI/ledger, exactly like the manual API flow.
    const row = gigRows.get(gig.dedupHash);
    if (row) {
      try {
        await saveProposal({
          gigId: row.id,
          platform: gig.platform,
          sourceGigId: gig.sourceGigId ?? undefined,
          coverLetter: applyResult.proposalDraft?.coverLetter ?? "",
          tailored: applyResult.proposalDraft?.tailored ?? false,
          mode: applyResult.mode,
          status: applyResult.status,
          externalRef: applyResult.externalRef,
          error: applyResult.error,
        });
        if (applyResult.status === "submitted" || applyResult.status === "exported") {
          await updateGigStatus(row.id, "submitted");
        } else if (applyResult.status !== "error") {
          await updateGigStatus(row.id, "proposed");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`proposal persist failed for ${gig.platform}/${gig.title}: ${message}`);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const report: WorkerCycleReport = {
    cycle: cycleNumber,
    startedAt,
    finishedAt,
    aggregate,
    persisted,
    topGigs: targets.map((gig) => ({
      platform: gig.platform,
      title: gig.title,
      clientOrEmployer: gig.clientOrEmployer,
      gigUrl: gig.gigUrl,
      suitabilityScore: gig.suitabilityScore,
    })),
    applies,
    autobidEnabled,
    errors,
  };

  logger.info("Freelance worker cycle finished", {
    cycle: cycleNumber,
    discovered: aggregate.discovered,
    enqueued: aggregate.enqueued,
    persisted: persisted.created + persisted.updated,
    applies: applies.length,
    autobidEnabled,
  });

  return report;
}

/**
 * Unattended worker loop. Never throws: a failing cycle is recorded and the
 * loop continues, which is what "runs unattended" actually requires.
 */
export async function runFreelanceWorker(
  options: WorkerOptions = {},
): Promise<WorkerCycleReport[]> {
  const cycles = options.cycles ?? 3;
  const intervalMs = options.intervalMs ?? 60_000;
  const reports: WorkerCycleReport[] = [];

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    if (options.shouldStop?.()) break;
    const report = await runWorkerCycle(cycle, options);
    reports.push(report);
    await options.onCycle?.(report);
    if (cycle < cycles && !options.shouldStop?.()) {
      await sleep(intervalMs);
    }
  }

  return reports;
}
