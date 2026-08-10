import { toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import {
  countGigsByStatus,
  countProposalsByStatus,
  earningsSummary,
  listEarnings,
  listGigs,
  listProposals,
  saveProposal,
  updateGigStatus,
  upsertGig,
} from "@server/repositories/freelance";
import {
  isFreelanceAutobidEnabled,
  resolveEnabledPlatforms,
  runAggregatorCycle,
} from "@server/services/freelance/aggregator";
import {
  buildDeterministicProposal,
  isFreelanceApplyEnabled,
} from "@server/services/freelance/apply-adapter";
import {
  computeDedupHash,
  heuristicGigScore,
} from "@server/services/freelance/dedupe";
import { getFreelanceProviderRegistry } from "@server/services/freelance/registry";
import type { FreelancePlatformId } from "@shared/types/freelance";
import { type Request, type Response, Router } from "express";

export const freelanceRouter = Router();

/**
 * GET /api/freelance/platforms — registry + config status per platform.
 */
freelanceRouter.get("/platforms", async (_req: Request, res: Response) => {
  try {
    const registry = await getFreelanceProviderRegistry();
    const platforms = [...registry.manifests.values()].map((m) => ({
      id: m.id,
      displayName: m.displayName,
      kind: m.kind,
      available: registry.availablePlatforms.includes(m.id),
      applyEnabled: isFreelanceApplyEnabled(process.env, m.id),
    }));
    ok(res, {
      platforms,
      autobidEnabled: isFreelanceAutobidEnabled(),
      enabledPlatforms: resolveEnabledPlatforms(),
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/freelance/gigs — persisted gigs (filter by status/platform/minScore).
 */
freelanceRouter.get("/gigs", async (req: Request, res: Response) => {
  try {
    const gigs = await listGigs({
      status: req.query.status as never,
      platform: req.query.platform as FreelancePlatformId | undefined,
      minScore:
        req.query.minScore != null
          ? Number.parseInt(String(req.query.minScore), 10)
          : undefined,
      limit:
        req.query.limit != null
          ? Number.parseInt(String(req.query.limit), 10)
          : 200,
    });
    ok(res, { gigs, count: gigs.length });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/freelance/run — one aggregation cycle, persisted to DB.
 */
freelanceRouter.post("/run", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      searchTerms?: string[];
      profileSkills?: string[];
      minScore?: number;
      platforms?: FreelancePlatformId[];
    };

    const cycle = await runAggregatorCycle({
      searchTerms: body.searchTerms,
      profileSkills: body.profileSkills,
      minScore: body.minScore,
      platforms: body.platforms,
    });

    // Persist scored gigs.
    let created = 0;
    let updated = 0;
    for (const gig of cycle.gigs) {
      const result = await upsertGig({
        ...gig,
        dedupHash: computeDedupHash(gig),
        suitabilityScore: gig.suitabilityScore ?? null,
      });
      if (result.created) created += 1;
      else updated += 1;
    }

    ok(res, {
      discovered: cycle.discovered,
      deduped: cycle.deduped,
      scored: cycle.scored,
      enqueued: cycle.enqueued,
      persisted: { created, updated },
      perPlatform: cycle.perPlatform,
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/freelance/gigs/:id/propose — generate a tailored proposal for a gig
 * and persist it. Dry-run unless the platform is explicitly opted in.
 */
freelanceRouter.post(
  "/gigs/:id/propose",
  async (req: Request, res: Response) => {
    try {
      const gigs = await listGigs({ limit: 10000 });
      const gig = gigs.find((g) => g.id === req.params.id);
      if (!gig) {
        return fail(res, toAppError(new Error("Gig not found")));
      }

      const profileSkills =
        ((req.body ?? {}) as { profileSkills?: string[] }).profileSkills ?? [];

      const draft = buildDeterministicProposal({
        gigId: gig.id,
        platform: gig.platform as FreelancePlatformId,
        gigTitle: gig.title,
        gigDescription: gig.gigDescription ?? gig.title,
        profileSkills,
      });

      const applyEnabled = isFreelanceApplyEnabled(
        process.env,
        gig.platform as FreelancePlatformId,
      );
      const mode = applyEnabled ? "draft" : "dry_run";

      const saved = await saveProposal({
        gigId: gig.id,
        platform: gig.platform as FreelancePlatformId,
        sourceGigId: gig.sourceGigId ?? undefined,
        coverLetter: draft.coverLetter,
        tailored: true,
        mode,
        status: "drafted",
      });

      await updateGigStatus(gig.id, "proposed");

      ok(res, { proposal: saved, mode, applyEnabled });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

/**
 * GET /api/freelance/proposals — persisted proposals.
 */
freelanceRouter.get("/proposals", async (req: Request, res: Response) => {
  try {
    const proposals = await listProposals(
      req.query.limit != null
        ? Number.parseInt(String(req.query.limit), 10)
        : 100,
    );
    ok(res, { proposals, count: proposals.length });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/freelance/stats — dashboard summary.
 */
freelanceRouter.get("/stats", async (_req: Request, res: Response) => {
  try {
    const [gigsByStatus, proposalsByStatus, earnings] = await Promise.all([
      countGigsByStatus(),
      countProposalsByStatus(),
      earningsSummary(),
    ]);
    ok(res, {
      gigsByStatus,
      proposalsByStatus,
      earnings,
      autobidEnabled: isFreelanceAutobidEnabled(),
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/freelance/earnings — earnings ledger.
 */
freelanceRouter.get("/earnings", async (req: Request, res: Response) => {
  try {
    const earnings = await listEarnings(
      req.query.limit != null
        ? Number.parseInt(String(req.query.limit), 10)
        : 100,
    );
    ok(res, { earnings, count: earnings.length });
  } catch (error) {
    fail(res, toAppError(error));
  }
});
