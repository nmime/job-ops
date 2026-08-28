import { badRequest, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import {
  countGigsByStatus,
  countProposalsByStatus,
  earningsSummary,
  listEarnings,
  listGigs,
  listProposals,
  recordEarning,
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
  credentialStatus,
  FREELANCE_CREDENTIAL_TABLE,
  statusVerdict,
} from "@server/services/freelance/credentials";
import { computeDedupHash } from "@server/services/freelance/dedupe";
import {
  type OperatorReport,
  applyOperatorReport,
  isProfilePlatform,
  listMergedProfiles,
  runProfileAction,
} from "@server/services/freelance/profile";
import { getFreelanceProviderRegistry } from "@server/services/freelance/registry";
import { verifyFreelanceAdapter } from "@server/services/freelance/verify";
import {
  FREELANCE_PLATFORM_IDS,
  type FreelancePlatformId,
} from "@shared/types/freelance";
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
 * GET /api/freelance/adapters — pure status for all 18 adapters.
 * No browser launches, no network calls: registry manifests + credential
 * presence only. For a live dry-run check use POST /verify/:platform.
 */
freelanceRouter.get("/adapters", async (_req: Request, res: Response) => {
  try {
    const registry = await getFreelanceProviderRegistry();
    const adapters = FREELANCE_PLATFORM_IDS.filter(
      (id) => id !== "aggregator-core",
    ).map((id) => {
      const manifest = registry.manifests.get(id);
      const table = FREELANCE_CREDENTIAL_TABLE[id];
      const credential = credentialStatus(id);
      return {
        platform: id,
        displayName: manifest?.displayName ?? table.displayName,
        kind: manifest?.kind ?? "freelance-marketplace",
        loaded: manifest !== undefined,
        discovery: {
          implemented: manifest
            ? typeof manifest.findGigs === "function"
            : false,
        },
        apply: {
          supported: manifest
            ? typeof manifest.applyToGig === "function"
            : false,
          kind: table.applyKind,
        },
        credential: {
          envVars: credential.envVars,
          format: credential.format,
          configured: credential.configured,
        },
        applyEnabled: isFreelanceApplyEnabled(process.env, id),
        // Status-level verdict (no discovery run): "not-applicable" for
        // platforms without per-gig apply, "blocked" when the credential is
        // missing, otherwise "verified" at status level.
        verdict: statusVerdict(id),
      };
    });
    ok(res, {
      adapters,
      note: "Status-level only (no discovery run). POST /api/freelance/verify/:platform for a live dry-run check.",
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/freelance/verify/:platform — full harness run for one platform:
 * credential status + discovery (90s timeout) + dry-run apply. Real
 * submission only when the request body is { "live": true }.
 */
freelanceRouter.post(
  "/verify/:platform",
  async (req: Request, res: Response) => {
    try {
      const platform = req.params.platform as FreelancePlatformId;
      if (
        !FREELANCE_PLATFORM_IDS.includes(platform) ||
        platform === "aggregator-core"
      ) {
        return fail(
          res,
          badRequest(
            `platform must be one of: ${FREELANCE_PLATFORM_IDS.filter(
              (id) => id !== "aggregator-core",
            ).join(", ")}`,
          ),
        );
      }

      const body = (req.body ?? {}) as { live?: boolean };
      const report = await verifyFreelanceAdapter(platform, {
        live: body.live === true,
        discoveryTimeoutMs: 90_000,
      });

      ok(res, report);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

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
 * POST /api/freelance/earnings — record a manual earnings entry in the ledger.
 */
freelanceRouter.post("/earnings", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      gigId?: string;
      platform?: string;
      amount?: number;
      currency?: string;
      status?: "pending" | "invoiced" | "paid" | "cancelled";
    };

    const platform = body.platform as FreelancePlatformId | undefined;
    if (
      !platform ||
      !FREELANCE_PLATFORM_IDS.includes(platform) ||
      platform === "aggregator-core"
    ) {
      return fail(
        res,
        badRequest(
          `platform must be one of: ${FREELANCE_PLATFORM_IDS.filter(
            (id) => id !== "aggregator-core",
          ).join(", ")}`,
        ),
      );
    }
    if (
      typeof body.amount !== "number" ||
      !Number.isFinite(body.amount) ||
      body.amount <= 0
    ) {
      return fail(res, badRequest("amount must be a positive number"));
    }
    const validStatuses = ["pending", "invoiced", "paid", "cancelled"];
    if (body.status != null && !validStatuses.includes(body.status)) {
      return fail(
        res,
        badRequest(`status must be one of: ${validStatuses.join(", ")}`),
      );
    }

    let gigId: string | undefined;
    if (body.gigId) {
      const gigs = await listGigs({ limit: 10000 });
      if (!gigs.some((g) => g.id === body.gigId)) {
        return fail(res, toAppError(new Error("Gig not found")));
      }
      gigId = body.gigId;
    }

    const earning = await recordEarning({
      gigId,
      platform,
      amount: body.amount,
      currency: body.currency,
      status: body.status,
    });

    ok(res, { earning });
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

// --- Profile campaign (docs/freelance-profile-campaign.md) -------------------------

/**
 * GET /api/freelance/profiles — campaign state for all 14 platforms
 * (registry + DB): field-level state, pending operator steps, content rows.
 * Optional ?platform=<id> filter.
 */
freelanceRouter.get("/profiles", async (req: Request, res: Response) => {
  try {
    const platform =
      typeof req.query.platform === "string" && req.query.platform.trim()
        ? req.query.platform.trim().toLowerCase()
        : undefined;
    if (platform && !isProfilePlatform(platform)) {
      return fail(
        res,
        badRequest(
          `platform must be one of: ${[
            "upwork",
            "freelancer",
            "fiverr",
            "toptal",
            "turing",
            "arc-dev",
            "peopleperhour",
            "guru",
            "flexjobs",
            "malt",
            "wellfound",
            "braintrust",
            "contra",
            "weworkremotely",
          ].join(", ")}`,
        ),
      );
    }
    const profiles = listMergedProfiles(platform ? [platform] : undefined);
    ok(res, {
      profiles,
      count: profiles.length,
      note: "Field state is DB-backed; `user_only` fields (dob, phone, face_photo, street_address) are never autofilled.",
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/freelance/profiles/:platform/:action — run one campaign action
 * through the platform's backend:
 *   complete | post | publish | promote
 *     api backend runs the idempotent fill scripts (re-read verified);
 *     browser backends queue a pending operator step list.
 *   record
 *     operator-reported results from the browser_mac backend:
 *     { completeness?, status?, fields?: {name: {status, value?, evidence?}},
 *       completedActionIds?: number[], content?: [{kind, title, status, externalRef?}] }
 */
freelanceRouter.post(
  "/profiles/:platform/:action",
  async (req: Request, res: Response) => {
    try {
      const platform = String(req.params.platform ?? "").toLowerCase();
      const action = String(req.params.action ?? "");
      if (!isProfilePlatform(platform)) {
        return fail(res, badRequest(`unknown profile platform: ${platform}`));
      }

      if (action === "record") {
        const report = (req.body ?? {}) as OperatorReport;
        if (
          !report.fields &&
          !report.completedActionIds &&
          !report.content &&
          !report.status &&
          !report.completeness
        ) {
          return fail(
            res,
            badRequest(
              "record requires at least one of: fields, completedActionIds, content, status, completeness",
            ),
          );
        }
        const { profile, updated } = applyOperatorReport(platform, report);
        return ok(res, { profile, updated });
      }

      const actionKinds = ["complete", "post", "publish", "promote"] as const;
      if (!actionKinds.includes(action as (typeof actionKinds)[number])) {
        return fail(
          res,
          badRequest(`action must be one of: ${[...actionKinds, "record"].join(", ")}`),
        );
      }

      const result = await runProfileAction(
        platform,
        action as (typeof actionKinds)[number],
      );
      ok(res, { result });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);
