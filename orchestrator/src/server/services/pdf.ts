/**
 * Service for generating PDF resumes from the local Design Resume when available,
 * falling back to the configured Reactive Resume base resume otherwise.
 */

import { existsSync } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { AppError, type AppErrorCode, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { getSetting } from "@server/repositories/settings";
import { getJobOpsPublicAvailability } from "@server/services/tracer-links";
import { settingsRegistry } from "@shared/settings-registry";
import type { DesignResumePdfResponse, PdfRenderer } from "@shared/types";
import { getCurrentDesignResume } from "./design-resume";
import { resolveWritingOutputLanguageForResumeJson } from "./output-language";
import {
  getLegacyJobPdfPath,
  getTenantDesignResumePdfPath,
  getTenantJobPdfPath,
  getTenantPdfDir,
} from "./pdf-storage";
import { renderResumePdf } from "./resume-renderer";
import {
  deleteResume as deleteRxResume,
  exportResumePdf as exportRxResumePdf,
  getResume as getRxResume,
  importResume as importRxResume,
  type PreparedRxResumePdfPayload,
  prepareTailoredResumeForPdf,
} from "./rxresume";
import { getConfiguredRxResumeBaseResumeId } from "./rxresume/baseResumeId";
import {
  mergeReactiveResumeV5Content,
  prepareReactiveResumeV5DocumentForExternalUse,
} from "./rxresume/document";
import { parseV5ResumeData } from "./rxresume/schema/v5";
import { getWritingStyle } from "./writing-style";

export interface PdfResult {
  success: boolean;
  pdfPath?: string;
  error?: string;
  errorCode?: AppErrorCode;
}

export interface TailoredPdfContent {
  summary?: string | null;
  headline?: string | null;
  skills?: Array<{ name: string; keywords: string[] }> | null;
}

export interface GeneratePdfOptions {
  tracerLinksEnabled?: boolean;
  requestOrigin?: string | null;
  tracerCompanyName?: string | null;
}

async function ensureOutputDir(): Promise<void> {
  const outputDir = getTenantPdfDir();
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }
}

function sanitizePdfFileName(value: string): string {
  const base = value
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return `${base || "Design_Resume"}.pdf`;
}

const TEMPORARY_RXRESUME_STATUS_RE = /\b(?:408|425|429|500|502|503|504)\b/;
const TEMPORARY_RXRESUME_TEXT_RE =
  /temporary|rate[- ]?limit|too many requests|retries exhausted|timeout|try again/i;
const MAX_RXRESUME_PDF_DOWNLOAD_RETRIES = 4;
const MAX_RXRESUME_PDF_DELAY_MS = 120_000;

type QueueTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const rxResumePdfQueue: QueueTask<unknown>[] = [];
let rxResumePdfActive = 0;

function rxResumePdfConcurrency(): number {
  const parsed = Number.parseInt(
    process.env.RXRESUME_PDF_CONCURRENCY ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 4) : 1;
}

function pumpRxResumePdfQueue(): void {
  while (
    rxResumePdfActive < rxResumePdfConcurrency() &&
    rxResumePdfQueue.length > 0
  ) {
    const task = rxResumePdfQueue.shift();
    if (!task) return;
    rxResumePdfActive += 1;
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        rxResumePdfActive -= 1;
        pumpRxResumePdfQueue();
      });
  }
}

function runRxResumePdfQueued<T>(run: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    rxResumePdfQueue.push({
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    pumpRxResumePdfQueue();
  });
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RXRESUME_PDF_DELAY_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(
      Math.max(0, dateMs - Date.now()),
      MAX_RXRESUME_PDF_DELAY_MS,
    );
  }
  return null;
}

function pdfRetryDelayMs(
  attemptIndex: number,
  retryAfterHeader: string | null,
): number {
  const retryAfter = parseRetryAfterMs(retryAfterHeader);
  if (retryAfter !== null) return retryAfter;
  return Math.min(
    1000 * 2 ** attemptIndex + Math.floor(Math.random() * 250),
    30_000,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTemporaryRxResumePdfError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    TEMPORARY_RXRESUME_TEXT_RE.test(message) ||
    TEMPORARY_RXRESUME_STATUS_RE.test(message)
  );
}

async function hasUsablePdf(outputPath: string): Promise<boolean> {
  try {
    const info = await stat(outputPath);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}

async function resolvePdfRenderer(): Promise<PdfRenderer> {
  const storedValue = await getSetting("pdfRenderer");
  return (
    settingsRegistry.pdfRenderer.parse(storedValue ?? undefined) ??
    settingsRegistry.pdfRenderer.default()
  );
}

async function resolveLatexResumeLanguage(resumeJson: Record<string, unknown>) {
  const writingStyle = await getWritingStyle();
  return resolveWritingOutputLanguageForResumeJson({
    style: writingStyle,
    resumeJson,
  }).language;
}

async function downloadRxResumePdf(
  url: string,
  outputPath: string,
): Promise<void> {
  let lastStatus = 0;
  for (
    let attempt = 0;
    attempt < MAX_RXRESUME_PDF_DOWNLOAD_RETRIES;
    attempt += 1
  ) {
    const response = await fetch(url);
    lastStatus = response.status;
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(outputPath, bytes);
      return;
    }

    const temporary = [408, 425, 429, 500, 502, 503, 504].includes(
      response.status,
    );
    if (!temporary || attempt >= MAX_RXRESUME_PDF_DOWNLOAD_RETRIES - 1) {
      throw new Error(
        `${temporary ? "Temporary " : ""}Reactive Resume PDF download failed with HTTP ${response.status}.`,
      );
    }

    const delayMs = pdfRetryDelayMs(
      attempt,
      response.headers.get("retry-after"),
    );
    logger.warn("Reactive Resume PDF download temporary failure; retrying", {
      status: response.status,
      attempt: attempt + 1,
      maxAttempts: MAX_RXRESUME_PDF_DOWNLOAD_RETRIES,
      delayMs,
    });
    await wait(delayMs);
  }

  throw new Error(
    `Temporary Reactive Resume PDF download failed with HTTP ${lastStatus}; retries exhausted.`,
  );
}

async function stripPictureWhenJobOpsIsNotHosted(args: {
  data: Record<string, unknown>;
  requestOrigin?: string | null;
}): Promise<Record<string, unknown>> {
  const picture =
    args.data.picture &&
    typeof args.data.picture === "object" &&
    !Array.isArray(args.data.picture)
      ? (args.data.picture as Record<string, unknown>)
      : null;
  if (!picture) return args.data;

  const pictureUrl = typeof picture.url === "string" ? picture.url.trim() : "";
  if (!/^\/api\/design-resume\/assets\/[^/]+\/content$/.test(pictureUrl)) {
    return args.data;
  }

  const availability = await getJobOpsPublicAvailability({
    requestOrigin: args.requestOrigin ?? null,
    force: false,
  });
  if (availability.isPubliclyAvailable) {
    return args.data;
  }

  return {
    ...args.data,
    picture: {
      ...picture,
      hidden: true,
      url: "",
    },
  };
}

async function renderRxResumePdf(args: {
  preparedResume: PreparedRxResumePdfPayload;
  outputPath: string;
  jobId: string;
  name?: string;
  requestOrigin?: string | null;
}): Promise<void> {
  const { preparedResume, outputPath, jobId } = args;
  let importedResumeId: string | null = null;
  const importData = prepareReactiveResumeV5DocumentForExternalUse(
    await stripPictureWhenJobOpsIsNotHosted({
      data: preparedResume.data,
      requestOrigin: args.requestOrigin ?? null,
    }),
    {
      requestOrigin: args.requestOrigin ?? null,
    },
  );

  try {
    await runRxResumePdfQueued(async () => {
      importedResumeId = await importRxResume({
        name: args.name?.trim() || `JobOps Tailored Resume ${jobId}`,
        data: importData,
      });

      const exportResult = await exportRxResumePdf(importedResumeId);
      if (exportResult.kind === "pdf") {
        await writeFile(outputPath, exportResult.bytes);
      } else {
        await downloadRxResumePdf(exportResult.url, outputPath);
      }
    });
  } catch (error) {
    if (
      isTemporaryRxResumePdfError(error) &&
      (await hasUsablePdf(outputPath))
    ) {
      logger.warn(
        "Reusing existing PDF after temporary Reactive Resume failure",
        {
          jobId,
          outputPath,
          error,
        },
      );
      return;
    }
    throw error;
  } finally {
    if (importedResumeId) {
      const resumeId = importedResumeId;
      try {
        await runRxResumePdfQueued(async () => deleteRxResume(resumeId));
      } catch (error) {
        logger.warn("Failed to clean up temporary Reactive Resume PDF export", {
          jobId,
          importedResumeId,
          error,
        });
      }
    }
  }
}

function classifyPdfGenerationError(error: unknown): AppErrorCode {
  if (error instanceof AppError) {
    return error.code;
  }

  if (
    error instanceof Error &&
    /Reactive Resume|RxResume/i.test(error.message)
  ) {
    return "UPSTREAM_ERROR";
  }

  if (error instanceof Error && error.name === "AbortError") {
    return "REQUEST_TIMEOUT";
  }

  return "INTERNAL_ERROR";
}

async function resolveDesignResumeForRenderer(args: {
  renderer: PdfRenderer;
  requestOrigin?: string | null;
}): Promise<{
  documentId: string;
  title: string;
  data: Record<string, unknown>;
  mode: "v5";
}> {
  const designResume = await getCurrentDesignResume();
  if (!designResume?.resumeJson) {
    throw notFound("Design Resume has not been imported yet.");
  }

  const localDocument = parseV5ResumeData(
    designResume.resumeJson as Record<string, unknown>,
  ) as Record<string, unknown>;

  if (
    args.renderer !== "rxresume" ||
    !designResume.sourceResumeId ||
    designResume.sourceMode !== "v5"
  ) {
    return {
      documentId: designResume.id,
      title: designResume.title,
      data: localDocument,
      mode: "v5",
    };
  }

  try {
    const upstreamResume = await getRxResume(designResume.sourceResumeId);

    if (!upstreamResume.data || typeof upstreamResume.data !== "object") {
      throw new Error("Reactive Resume base resume is empty or invalid.");
    }

    const upstreamDocument = parseV5ResumeData(
      upstreamResume.data as Record<string, unknown>,
    ) as Record<string, unknown>;

    return {
      documentId: designResume.id,
      title: designResume.title,
      data: mergeReactiveResumeV5Content(upstreamDocument, localDocument, {
        requestOrigin: args.requestOrigin ?? null,
      }) as Record<string, unknown>,
      mode: "v5",
    };
  } catch (error) {
    logger.warn(
      "Failed to refresh Reactive Resume template metadata for Design Resume rendering",
      {
        documentId: designResume.id,
        sourceResumeId: designResume.sourceResumeId,
        sourceMode: designResume.sourceMode,
        error,
      },
    );

    return {
      documentId: designResume.id,
      title: designResume.title,
      data: localDocument,
      mode: "v5",
    };
  }
}

async function loadBaseResumeSource(args: {
  renderer: PdfRenderer;
  requestOrigin?: string | null;
}): Promise<{
  data: Record<string, unknown>;
  mode: "v5";
}> {
  const designResume = await getCurrentDesignResume();
  if (designResume?.resumeJson) {
    if (args.renderer === "rxresume") {
      const resolved = await resolveDesignResumeForRenderer({
        renderer: args.renderer,
        requestOrigin: args.requestOrigin ?? null,
      });
      return {
        data: resolved.data,
        mode: "v5",
      };
    }

    return {
      data: parseV5ResumeData(
        designResume.resumeJson as Record<string, unknown>,
      ) as Record<string, unknown>,
      mode: "v5",
    };
  }

  const { resumeId: baseResumeId } = await getConfiguredRxResumeBaseResumeId();
  if (!baseResumeId) {
    throw new Error(
      "No Design Resume found, and no Reactive Resume base resume is configured. Import a Design Resume or select a base resume in Settings.",
    );
  }

  const baseResume = await getRxResume(baseResumeId);
  if (!baseResume.data || typeof baseResume.data !== "object") {
    throw new Error("Reactive Resume base resume is empty or invalid.");
  }

  return {
    data: baseResume.data as Record<string, unknown>,
    mode: "v5",
  };
}

/**
 * Generate a tailored PDF resume for a job using the configured resume source.
 *
 * Flow:
 * 1. Prepare resume data with tailored content and project selection
 * 2. Normalize the tailored resume into the renderer document model
 * 3. Render a PDF with the active renderer
 */
export async function generatePdf(
  jobId: string,
  tailoredContent: TailoredPdfContent,
  jobDescription: string,
  _baseResumePath?: string, // Deprecated: now always uses Design Resume or the configured Reactive Resume base resume
  selectedProjectIds?: string | null,
  options?: GeneratePdfOptions,
): Promise<PdfResult> {
  let renderer: PdfRenderer | null = null;

  try {
    renderer = await resolvePdfRenderer();
    logger.info("Generating PDF resume", { jobId, renderer });

    // Ensure output directory exists
    await ensureOutputDir();

    const baseResume = await loadBaseResumeSource({
      renderer,
      requestOrigin: options?.requestOrigin ?? null,
    });

    let preparedResume: Awaited<
      ReturnType<typeof prepareTailoredResumeForPdf>
    > | null = null;
    try {
      preparedResume = await prepareTailoredResumeForPdf({
        resumeData: baseResume.data,
        tailoredContent,
        jobDescription,
        selectedProjectIds,
        jobId,
        tracerLinks: {
          enabled: Boolean(options?.tracerLinksEnabled),
          requestOrigin: options?.requestOrigin ?? null,
          companyName: options?.tracerCompanyName ?? null,
        },
      });
    } catch (err) {
      logger.warn("Resume tailoring step failed during PDF generation", {
        jobId,
        error: err,
      });
      throw err;
    }

    const outputPath = getTenantJobPdfPath(jobId);
    if (renderer === "latex") {
      const language = await resolveLatexResumeLanguage(preparedResume.data);
      await renderResumePdf({
        resumeJson: preparedResume.data,
        outputPath,
        jobId,
        language,
      });
    } else {
      await renderRxResumePdf({
        preparedResume,
        outputPath,
        jobId,
        requestOrigin: options?.requestOrigin ?? null,
      });
    }

    logger.info("PDF generated successfully", { jobId, outputPath, renderer });
    return { success: true, pdfPath: outputPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("PDF generation failed", { jobId, renderer, error });
    return {
      success: false,
      error: message,
      errorCode: classifyPdfGenerationError(error),
    };
  }
}

export async function generateDesignResumePdf(options?: {
  requestOrigin?: string | null;
}): Promise<DesignResumePdfResponse> {
  const renderer = await resolvePdfRenderer();
  const designResume = await resolveDesignResumeForRenderer({
    renderer,
    requestOrigin: options?.requestOrigin ?? null,
  });
  const generatedAt = new Date().toISOString();
  const outputPath = getTenantDesignResumePdfPath();
  const preparedResume: PreparedRxResumePdfPayload = {
    mode: "v5",
    data: structuredClone(designResume.data) as Record<string, unknown>,
    projectCatalog: [],
    selectedProjectIds: [],
  };

  await ensureOutputDir();

  logger.info("Generating Design Resume PDF", {
    renderer,
    documentId: designResume.documentId,
  });

  if (renderer === "latex") {
    const language = await resolveLatexResumeLanguage(designResume.data);
    await renderResumePdf({
      resumeJson: designResume.data,
      outputPath,
      jobId: "design-resume",
      language,
    });
  } else {
    await renderRxResumePdf({
      preparedResume,
      outputPath,
      jobId: "design-resume",
      name: designResume.title,
      requestOrigin: options?.requestOrigin ?? null,
    });
  }

  return {
    fileName: sanitizePdfFileName(designResume.title),
    pdfUrl: `/api/design-resume/pdf?v=${encodeURIComponent(generatedAt)}`,
    generatedAt,
  };
}

/**
 * Check if a PDF exists for a job.
 */
export async function pdfExists(jobId: string): Promise<boolean> {
  const pdfPath = getTenantJobPdfPath(jobId);
  try {
    await access(pdfPath);
    return true;
  } catch {
    try {
      await access(getLegacyJobPdfPath(jobId));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get the path to a job's PDF.
 */
export function getPdfPath(jobId: string): string {
  const pdfPath = getTenantJobPdfPath(jobId);
  if (existsSync(pdfPath)) return pdfPath;
  return getLegacyJobPdfPath(jobId);
}
