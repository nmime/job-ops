import { badRequest, notFound } from "@infra/errors";
import { fail, ok, okWithMeta } from "@infra/http";
import { logger } from "@infra/logger";
import { trackServerProductEvent } from "@infra/product-analytics";
import { isDemoMode } from "@server/config/demo";
import { resolveRequestOrigin } from "@server/infra/request-origin";
import * as jobsRepo from "@server/repositories/jobs";
import { trackCanonicalActivationEvent } from "@server/services/activation-funnel";
import { transitionStage } from "@server/services/applicationTracking";
import {
  type EmailAutoApplyResult,
  resolveAutoApplyRecipient,
  resolveHttpApplicationUrl,
  sendAutoApplication,
} from "@server/services/auto-apply";
import { submitPortalApplication } from "@server/services/application-browser";
import { simulateApplyJob } from "@server/services/demo-simulator";
import { notifyJobCompleteWebhook } from "@server/services/jobs/webhooks";
import * as visaSponsors from "@server/services/visa-sponsors/index";
import type { Job } from "@shared/types";
import { type Request, type Response, Router } from "express";
import { hydrateJobPdfFreshness, requireJob, toJobsRouteError } from "./shared";

export const jobsApplicationRouter = Router();

type JobsRouteAutoApplyResult =
  | EmailAutoApplyResult
  | Awaited<ReturnType<typeof submitPortalApplication>>;

function parseBooleanFlag(value: unknown): boolean {
  return (
    value === true ||
    value === "true" ||
    value === "1" ||
    value === 1 ||
    value === "yes"
  );
}

async function runJobsRouteAutoApply(
  job: Job,
  body: unknown,
): Promise<JobsRouteAutoApplyResult> {
  const hydratedJob = await hydrateJobPdfFreshness(job);
  const httpUrl = resolveHttpApplicationUrl(hydratedJob);
  const recipient = resolveAutoApplyRecipient(hydratedJob);
  const explicitEmailRoute = Boolean(
    hydratedJob.applicationLink?.trim().toLowerCase().startsWith("mailto:") ||
      (recipient && !hydratedJob.applicationLink && !hydratedJob.jobUrlDirect),
  );
  const enableBrowser =
    parseBooleanFlag((body as { enableBrowser?: unknown })?.enableBrowser) ||
    parseBooleanFlag((body as { browserApply?: unknown })?.browserApply) ||
    parseBooleanFlag((body as { portalApply?: unknown })?.portalApply);

  if (explicitEmailRoute) {
    return sendAutoApplication(hydratedJob);
  }

  if (httpUrl && enableBrowser) {
    return submitPortalApplication(hydratedJob, {
      allowCaptcha: parseBooleanFlag(
        (body as { allowCaptcha?: unknown })?.allowCaptcha,
      ),
      dryRun: parseBooleanFlag((body as { dryRun?: unknown })?.dryRun),
    });
  }

  return sendAutoApplication(hydratedJob);
}

function autoApplyMarksApplied(autoApply: JobsRouteAutoApplyResult): boolean {
  return autoApply.mode === "email" || autoApply.status === "submitted";
}

function autoApplyStageNote(autoApply: JobsRouteAutoApplyResult): string {
  return autoApply.mode === "email"
    ? `Sent ${autoApply.mode} application to ${autoApply.recipient}`
    : `Submitted browser application to ${autoApply.finalUrl || autoApply.url}`;
}

jobsApplicationRouter.post(
  "/:id/check-sponsor",
  async (req: Request, res: Response) => {
    try {
      const job = await requireJob(req.params.id);

      if (!job.employer) {
        return fail(res, badRequest("Job has no employer name"));
      }

      const sponsorResults = await visaSponsors.searchSponsors(job.employer, {
        limit: 10,
        minScore: 50,
      });

      const { sponsorMatchScore, sponsorMatchNames } =
        visaSponsors.calculateSponsorMatchSummary(sponsorResults);

      const updatedJob = await jobsRepo.updateJob(job.id, {
        sponsorMatchScore: sponsorMatchScore,
        sponsorMatchNames: sponsorMatchNames ?? undefined,
      });

      if (!updatedJob) {
        return fail(res, notFound("Job not found"));
      }

      if (sponsorMatchScore >= 50 && sponsorResults.length > 0) {
        void trackServerProductEvent(
          "sponsor_match_found",
          {
            match_score: sponsorMatchScore,
            match_count: sponsorResults.length,
          },
          {
            requestOrigin: resolveRequestOrigin(req),
            urlPath: "/visa-sponsors",
          },
        );
      }

      ok(res, {
        ...(await hydrateJobPdfFreshness(updatedJob)),
        matchResults: sponsorResults.slice(0, 5).map((r) => ({
          name: r.sponsor.organisationName,
          score: r.score,
        })),
      });
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);

jobsApplicationRouter.post(
  "/:id/apply",
  async (req: Request, res: Response) => {
    try {
      if (isDemoMode()) {
        const updatedJob = await simulateApplyJob(req.params.id);
        return okWithMeta(res, await hydrateJobPdfFreshness(updatedJob), {
          simulated: true,
        });
      }

      const job = await requireJob(req.params.id);

      const appliedAtDate = new Date();
      const appliedAt = appliedAtDate.toISOString();

      transitionStage(
        job.id,
        "applied",
        Math.floor(appliedAtDate.getTime() / 1000),
        {
          eventLabel: "Applied",
          actor: "system",
        },
        null,
      );

      const updatedJob = await jobsRepo.updateJob(job.id, {
        status: "applied",
        appliedAt,
      });

      if (updatedJob) {
        void trackCanonicalActivationEvent(
          "application_marked_applied",
          {
            source: "jobs_apply_route",
            had_pdf: Boolean(updatedJob.pdfPath),
            tracer_links_enabled: Boolean(updatedJob.tracerLinksEnabled),
            sponsor_match_found:
              typeof updatedJob.sponsorMatchScore === "number" &&
              updatedJob.sponsorMatchScore >= 50,
          },
          {
            occurredAt: appliedAtDate,
            requestOrigin: resolveRequestOrigin(req),
            urlPath: "/jobs",
          },
        );
        notifyJobCompleteWebhook(updatedJob).catch((error) => {
          logger.warn("Job complete webhook dispatch failed", error);
        });
      }

      if (!updatedJob) {
        return fail(res, notFound("Job not found"));
      }

      ok(res, await hydrateJobPdfFreshness(updatedJob));
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);

jobsApplicationRouter.post(
  "/:id/auto-apply",
  async (req: Request, res: Response) => {
    try {
      if (req.body?.confirm !== true) {
        return fail(
          res,
          badRequest("Confirm this real application before auto-applying."),
        );
      }

      if (isDemoMode()) {
        const updatedJob = await simulateApplyJob(req.params.id);
        return okWithMeta(res, await hydrateJobPdfFreshness(updatedJob), {
          simulated: true,
        });
      }

      const job = await requireJob(req.params.id);
      const autoApply = await runJobsRouteAutoApply(job, req.body);

      if (!autoApplyMarksApplied(autoApply)) {
        return ok(res, {
          ...(await hydrateJobPdfFreshness(job)),
          autoApply,
        });
      }

      const appliedAtDate = new Date();
      const appliedAt = appliedAtDate.toISOString();

      transitionStage(
        job.id,
        "applied",
        Math.floor(appliedAtDate.getTime() / 1000),
        {
          eventLabel: "Auto-applied",
          actor: "system",
          note: autoApplyStageNote(autoApply),
        },
        null,
      );

      const updatedJob = await jobsRepo.updateJob(job.id, {
        status: "applied",
        appliedAt,
      });

      if (updatedJob) {
        void trackCanonicalActivationEvent(
          "application_marked_applied",
          {
            source: "jobs_auto_apply_route",
            had_pdf: Boolean(updatedJob.pdfPath),
            tracer_links_enabled: Boolean(updatedJob.tracerLinksEnabled),
            sponsor_match_found:
              typeof updatedJob.sponsorMatchScore === "number" &&
              updatedJob.sponsorMatchScore >= 50,
          },
          {
            occurredAt: appliedAtDate,
            requestOrigin: resolveRequestOrigin(req),
            urlPath: "/jobs",
          },
        );
        notifyJobCompleteWebhook(updatedJob).catch((error) => {
          logger.warn("Job complete webhook dispatch failed", error);
        });
      }

      if (!updatedJob) {
        return fail(res, notFound("Job not found"));
      }

      ok(res, {
        ...(await hydrateJobPdfFreshness(updatedJob)),
        autoApply,
      });
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);
