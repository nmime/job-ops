import { badRequest, forbidden } from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { isSystemAdmin } from "@infra/request-context";
import {
  getLatestAutomationProofResult,
  runAutomationProof,
} from "@server/services/automation-proof";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const automationProofRouter = Router();

const runProofSchema = z
  .object({
    dryRun: z.literal(true),
  })
  .strict();

function requireSystemAdmin(res: Response): boolean {
  if (isSystemAdmin()) return true;
  fail(res, forbidden("System admin access is required"));
  return false;
}

automationProofRouter.post(
  "/proof/run",
  asyncRoute(async (req: Request, res: Response) => {
    if (!requireSystemAdmin(res)) return;
    const parsed = runProofSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(
        res,
        badRequest(
          "Automation proof mode only accepts dryRun:true.",
          parsed.error.flatten(),
        ),
      );
      return;
    }

    const result = await runAutomationProof();
    ok(res, result, 201);
  }),
);

automationProofRouter.get(
  "/proof/latest",
  asyncRoute(async (_req: Request, res: Response) => {
    if (!requireSystemAdmin(res)) return;
    ok(res, { latest: await getLatestAutomationProofResult() });
  }),
);
