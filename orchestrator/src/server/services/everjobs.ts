import { logger } from "@infra/logger";
import { buildLocationEvidence } from "@shared/location-domain.js";
import { formatCountryLabel } from "@shared/location-support.js";
import type { CreateJobInput } from "@shared/types/jobs";
import type { LocationIntent } from "@shared/types/location";

const DEFAULT_MAX_JOBS_PER_TERM = 25;
const MAX_JOBS_PER_TERM_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MIN_DELAY_MS = 250;
const MAX_MIN_DELAY_MS = 10_000;
const DEFAULT_API_KEY_HEADER = "x-api-key";

const TRUE_VALUES = new Set(["1", "true"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface EverJobsConfig {
  enabled: boolean;
  apiUrl: string | null;
  apiKey: string | null;
  apiKeyHeader: string;
  maxJobsPerTerm: number;
  timeoutMs: number;
  minDelayMs: number;
  siteTypes: string[];
}

export type EverJobsProgressEvent =
  | {
      type: "term_start";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
    }
  | {
      type: "term_complete";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      jobsFoundTerm: number;
    };

export interface RunEverJobsOptions {
  searchTerms: string[];
  selectedCountry?: string;
  locationIntent?: LocationIntent;
  existingJobUrls?: string[];
  shouldCancel?: () => boolean;
  onProgress?: (event: EverJobsProgressEvent) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface EverJobsResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function isEnabledFlag(raw: string | undefined): boolean {
  return TRUE_VALUES.has(raw?.trim().toLowerCase() ?? "");
}

function parseBoundedInteger(args: {
  raw: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  const parsed = args.raw ? Number.parseInt(args.raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return args.fallback;
  return Math.min(Math.max(Math.floor(parsed), args.min), args.max);
}

function normalizeApiUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function parseSiteTypes(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];

  const normalize = (values: unknown[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      if (typeof value !== "string") continue;
      const next = value.trim();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      out.push(next);
    }
    return out;
  };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return normalize(parsed);
    if (typeof parsed === "string") return normalize([parsed]);
  } catch {
    // Fall back to comma-separated parsing below.
  }

  return normalize(trimmed.split(","));
}

function normalizeHeaderName(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed || !HEADER_NAME_PATTERN.test(trimmed)) {
    return DEFAULT_API_KEY_HEADER;
  }
  return trimmed;
}

export function resolveEverJobsConfig(
  env: NodeJS.ProcessEnv = process.env,
): EverJobsConfig {
  return {
    enabled: isEnabledFlag(env.EVER_JOBS_ENABLED),
    apiUrl: normalizeApiUrl(env.EVER_JOBS_API_URL),
    apiKey: env.EVER_JOBS_API_KEY?.trim() || null,
    apiKeyHeader: normalizeHeaderName(env.EVER_JOBS_API_KEY_HEADER),
    maxJobsPerTerm: parseBoundedInteger({
      raw: env.EVER_JOBS_MAX_JOBS_PER_TERM,
      fallback: DEFAULT_MAX_JOBS_PER_TERM,
      min: 1,
      max: MAX_JOBS_PER_TERM_LIMIT,
    }),
    timeoutMs: parseBoundedInteger({
      raw: env.EVER_JOBS_TIMEOUT_MS,
      fallback: DEFAULT_TIMEOUT_MS,
      min: MIN_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
    }),
    minDelayMs: parseBoundedInteger({
      raw: env.EVER_JOBS_MIN_DELAY_MS,
      fallback: DEFAULT_MIN_DELAY_MS,
      min: 0,
      max: MAX_MIN_DELAY_MS,
    }),
    siteTypes: parseSiteTypes(env.EVER_JOBS_SITE_TYPES),
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function getStringField(
  record: UnknownRecord,
  fieldNames: readonly string[],
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = getString(record[fieldName]);
    if (value) return value;
  }
  return undefined;
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getNumberField(
  record: UnknownRecord,
  fieldNames: readonly string[],
): number | undefined {
  for (const fieldName of fieldNames) {
    const value = getNumber(record[fieldName]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "remote"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return undefined;
}

function getBooleanField(
  record: UnknownRecord,
  fieldNames: readonly string[],
): boolean | undefined {
  for (const fieldName of fieldNames) {
    const value = getBoolean(record[fieldName]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return value.trim() || undefined;
  }
}

function normalizeUrlForDedupe(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase() || undefined;
  }
}

function getCompanyName(record: UnknownRecord): string | undefined {
  const direct = getStringField(record, [
    "employer",
    "companyName",
    "company_name",
    "organization",
    "organizationName",
    "client",
  ]);
  if (direct) return direct;

  for (const fieldName of ["company", "employer", "organization"] as const) {
    const nested = record[fieldName];
    if (!isRecord(nested)) continue;
    const nestedName = getStringField(nested, [
      "name",
      "companyName",
      "company_name",
      "displayName",
    ]);
    if (nestedName) return nestedName;
  }

  return undefined;
}

function getCompanyUrl(record: UnknownRecord): string | undefined {
  const direct = getStringField(record, [
    "employerUrl",
    "companyUrl",
    "company_url",
    "companyWebsite",
  ]);
  if (direct) return normalizeUrl(direct);

  const company = record.company;
  if (isRecord(company)) {
    return normalizeUrl(
      getStringField(company, ["url", "website", "companyUrl", "homeUrl"]),
    );
  }

  return undefined;
}

function getLocation(record: UnknownRecord): string | undefined {
  const direct = getStringField(record, [
    "location",
    "jobLocation",
    "job_location",
    "locationName",
    "formattedLocation",
  ]);
  if (direct) return direct;

  const nested = record.location;
  if (isRecord(nested)) {
    const parts = [
      getStringField(nested, ["city", "name"]),
      getStringField(nested, ["region", "state"]),
      getStringField(nested, ["country", "countryName"]),
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join(", ");
  }

  const locations = record.locations;
  if (Array.isArray(locations)) {
    const values = locations
      .map((location) => {
        if (typeof location === "string") return location.trim();
        if (isRecord(location)) return getLocation({ location });
        return undefined;
      })
      .filter((location): location is string => Boolean(location));
    if (values.length > 0) return values.join("; ");
  }

  return undefined;
}

function getSkills(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const skills = value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (isRecord(item)) return getStringField(item, ["name", "label"]);
        return undefined;
      })
      .filter((item): item is string => Boolean(item));
    return skills.length > 0 ? skills.join(", ") : undefined;
  }
  return undefined;
}

function getSalaryText(record: UnknownRecord): string | undefined {
  const salary = record.salary;
  if (typeof salary === "string" && salary.trim()) return salary.trim();
  if (isRecord(salary)) {
    const text = getStringField(salary, ["text", "display", "range", "value"]);
    if (text) return text;
  }

  const direct = getStringField(record, [
    "salaryText",
    "salaryRange",
    "salary_range",
    "compensation",
  ]);
  if (direct) return direct;

  const min = getNumberField(record, [
    "salaryMinAmount",
    "salaryMin",
    "salary_min",
    "minSalary",
  ]);
  const max = getNumberField(record, [
    "salaryMaxAmount",
    "salaryMax",
    "salary_max",
    "maxSalary",
  ]);
  const currency = getStringField(record, [
    "salaryCurrency",
    "currency",
    "salary_currency",
  ]);

  if (min !== undefined && max !== undefined) {
    return `${currency ? `${currency} ` : ""}${min}-${max}`;
  }
  if (min !== undefined) return `${currency ? `${currency} ` : ""}${min}+`;
  if (max !== undefined) return `${currency ? `${currency} ` : ""}up to ${max}`;
  return undefined;
}

function getJobUrl(record: UnknownRecord): string | undefined {
  return normalizeUrl(
    getStringField(record, [
      "jobUrl",
      "job_url",
      "url",
      "link",
      "canonicalUrl",
      "postingUrl",
      "applyUrl",
      "apply_url",
      "applicationUrl",
      "application_url",
      "jobUrlDirect",
      "job_url_direct",
    ]),
  );
}

function getApplyUrl(record: UnknownRecord): string | undefined {
  return normalizeUrl(
    getStringField(record, [
      "applyUrl",
      "apply_url",
      "applicationUrl",
      "application_url",
      "applicationLink",
    ]),
  );
}

function getDirectUrl(record: UnknownRecord): string | undefined {
  return normalizeUrl(
    getStringField(record, ["jobUrlDirect", "job_url_direct", "directUrl"]),
  );
}

function extractJobsArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  for (const fieldName of ["jobs", "results", "items", "data"] as const) {
    const value = payload[fieldName];
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
      for (const nestedFieldName of ["jobs", "results", "items"] as const) {
        const nested = value[nestedFieldName];
        if (Array.isArray(nested)) return nested;
      }
    }
  }

  return [];
}

function inferRemote(
  record: UnknownRecord,
  location: string | undefined,
): boolean | undefined {
  const direct = getBooleanField(record, [
    "isRemote",
    "remote",
    "is_remote",
    "workFromHome",
  ]);
  if (direct !== undefined) return direct;

  const workplaceType = getStringField(record, [
    "workplaceType",
    "work_from_home_type",
    "workArrangement",
  ])?.toLowerCase();
  if (workplaceType) {
    if (workplaceType.includes("remote")) return true;
    if (workplaceType.includes("onsite") || workplaceType.includes("hybrid")) {
      return false;
    }
  }

  return location
    ? /remote|worldwide|anywhere|work from home|wfh/i.test(location)
    : undefined;
}

export function mapEverJobsJob(
  rawJob: unknown,
  args: { selectedCountry?: string } = {},
): CreateJobInput | null {
  if (!isRecord(rawJob)) return null;

  const title = getStringField(rawJob, [
    "title",
    "jobTitle",
    "job_title",
    "name",
    "position",
    "role",
    "positionTitle",
  ]);
  const jobUrl = getJobUrl(rawJob);
  if (!title || !jobUrl) return null;

  const location = getLocation(rawJob);
  const isRemote = inferRemote(rawJob, location);
  const id = getStringField(rawJob, ["id", "jobId", "job_id", "_id", "uuid"]);
  const employer = getCompanyName(rawJob) ?? "Unknown";
  const applyUrl = getApplyUrl(rawJob);
  const directUrl = getDirectUrl(rawJob);
  const salaryMinAmount = getNumberField(rawJob, [
    "salaryMinAmount",
    "salaryMin",
    "salary_min",
    "minSalary",
  ]);
  const salaryMaxAmount = getNumberField(rawJob, [
    "salaryMaxAmount",
    "salaryMax",
    "salary_max",
    "maxSalary",
  ]);
  const salaryCurrency = getStringField(rawJob, [
    "salaryCurrency",
    "currency",
    "salary_currency",
  ]);

  return {
    source: "everjobs",
    sourceJobId: id ?? jobUrl,
    title,
    employer,
    employerUrl: getCompanyUrl(rawJob),
    jobUrl,
    applicationLink: applyUrl,
    jobUrlDirect: directUrl,
    location,
    locationEvidence: buildLocationEvidence({
      location,
      country: args.selectedCountry,
      isRemote,
      source: "everjobs",
      sourceNotes: ["source:everjobs"],
    }),
    jobDescription: getStringField(rawJob, [
      "descriptionMarkdown",
      "description_markdown",
      "description",
      "jobDescription",
      "job_description",
      "content",
      "snippet",
    ]),
    salary: getSalaryText(rawJob),
    salaryMinAmount,
    salaryMaxAmount,
    salaryCurrency,
    salarySource:
      salaryMinAmount !== undefined || salaryMaxAmount !== undefined
        ? "everjobs"
        : undefined,
    datePosted: getStringField(rawJob, [
      "datePosted",
      "date_posted",
      "postedAt",
      "posted_at",
      "createdAt",
    ]),
    jobType: getStringField(rawJob, [
      "jobType",
      "job_type",
      "employmentType",
      "employment_type",
      "type",
    ]),
    isRemote,
    skills: getSkills(rawJob.skills ?? rawJob.tags ?? rawJob.keywords),
    listingType: getStringField(rawJob, ["siteType", "site_type", "source"]),
    companyLogo: normalizeUrl(getStringField(rawJob, ["companyLogo", "logo"])),
  };
}

function buildSearchUrl(apiUrl: string, pageSize: number): string {
  const url = new URL(apiUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!normalizedPath.endsWith("/api/jobs/search")) {
    url.pathname = `${normalizedPath}/api/jobs/search`.replace(/\/+/g, "/");
  }
  url.searchParams.set("dedup", "true");
  url.searchParams.set("paginate", "true");
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", String(pageSize));
  return url.toString();
}

function buildRequestBody(args: {
  searchTerm: string;
  config: EverJobsConfig;
  selectedCountry?: string;
  locationIntent?: LocationIntent;
}): UnknownRecord {
  const selectedCountry =
    args.locationIntent?.selectedCountry ?? args.selectedCountry ?? "";
  const countryLabel = selectedCountry
    ? formatCountryLabel(selectedCountry)
    : undefined;
  const cityLocations = args.locationIntent?.cityLocations ?? [];
  const workplaceTypes = args.locationIntent?.workplaceTypes ?? [];
  const body: UnknownRecord = {
    searchTerm: args.searchTerm,
    resultsWanted: args.config.maxJobsPerTerm,
    descriptionFormat: "markdown",
  };

  const location =
    cityLocations.length > 0 ? cityLocations.join(" | ") : countryLabel;
  if (location) body.location = location;
  if (countryLabel) body.country = countryLabel;

  if (workplaceTypes.length > 0) {
    if (workplaceTypes.length === 1 && workplaceTypes[0] === "remote") {
      body.isRemote = true;
    } else if (!workplaceTypes.includes("remote")) {
      body.isRemote = false;
    }
  }

  if (args.config.siteTypes.length === 1) {
    body.siteType = args.config.siteTypes[0];
  } else if (args.config.siteTypes.length > 1) {
    body.siteType = args.config.siteTypes;
  }

  return body;
}

async function wait(ms: number, shouldCancel?: () => boolean): Promise<void> {
  if (ms <= 0 || shouldCancel?.()) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function postSearch(args: {
  url: string;
  body: UnknownRecord;
  config: EverJobsConfig;
  fetchImpl: typeof fetch;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.config.timeoutMs);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (args.config.apiKey) {
    headers[args.config.apiKeyHeader] = args.config.apiKey;
  }

  try {
    const response = await args.fetchImpl(args.url, {
      method: "POST",
      headers,
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Ever Jobs API returned HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function normalizeTerms(searchTerms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const searchTerm of searchTerms) {
    const normalized = searchTerm.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
  }
  return out;
}

export async function runEverJobs(
  options: RunEverJobsOptions,
): Promise<EverJobsResult> {
  const config = resolveEverJobsConfig(options.env);
  if (!config.enabled) {
    logger.info("Ever Jobs extractor bridge disabled", {
      source: "everjobs",
      enabled: false,
    });
    return { success: true, jobs: [] };
  }

  if (!config.apiUrl) {
    return {
      success: false,
      jobs: [],
      error: "EVER_JOBS_API_URL is required when EVER_JOBS_ENABLED is true.",
    };
  }

  if (options.shouldCancel?.()) return { success: true, jobs: [] };

  let searchUrl: string;
  try {
    searchUrl = buildSearchUrl(config.apiUrl, config.maxJobsPerTerm);
  } catch {
    return {
      success: false,
      jobs: [],
      error: "EVER_JOBS_API_URL must be a valid absolute URL.",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const searchTerms = normalizeTerms(options.searchTerms);
  if (searchTerms.length === 0) return { success: true, jobs: [] };

  const existingUrlKeys = new Set(
    (options.existingJobUrls ?? [])
      .map((url) => normalizeUrlForDedupe(url))
      .filter((url): url is string => Boolean(url)),
  );
  const seenKeys = new Set<string>();
  const jobs: CreateJobInput[] = [];
  const errors: string[] = [];

  for (let index = 0; index < searchTerms.length; index += 1) {
    if (options.shouldCancel?.()) break;
    if (index > 0) await wait(config.minDelayMs, options.shouldCancel);
    if (options.shouldCancel?.()) break;

    const searchTerm = searchTerms[index];
    options.onProgress?.({
      type: "term_start",
      termIndex: index + 1,
      termTotal: searchTerms.length,
      searchTerm,
    });

    try {
      const payload = await postSearch({
        url: searchUrl,
        body: buildRequestBody({
          searchTerm,
          config,
          selectedCountry: options.selectedCountry,
          locationIntent: options.locationIntent,
        }),
        config,
        fetchImpl,
      });
      const rawJobs = extractJobsArray(payload);
      let jobsFoundTerm = 0;
      for (const rawJob of rawJobs) {
        const mapped = mapEverJobsJob(rawJob, {
          selectedCountry:
            options.locationIntent?.selectedCountry ?? options.selectedCountry,
        });
        if (!mapped) continue;

        const urlKey = normalizeUrlForDedupe(mapped.jobUrl);
        if (urlKey && existingUrlKeys.has(urlKey)) continue;
        const dedupeKey = urlKey ?? `id:${mapped.sourceJobId ?? mapped.jobUrl}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        jobs.push(mapped);
        jobsFoundTerm += 1;
      }

      options.onProgress?.({
        type: "term_complete",
        termIndex: index + 1,
        termTotal: searchTerms.length,
        searchTerm,
        jobsFoundTerm,
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      errors.push(`${searchTerm}: ${message}`);
      logger.warn("Ever Jobs search term failed", {
        source: "everjobs",
        searchTerm,
        error: message,
      });
    }
  }

  if (errors.length === searchTerms.length && jobs.length === 0) {
    return {
      success: false,
      jobs: [],
      error: `Ever Jobs search failed for all terms: ${errors.join("; ")}`,
    };
  }

  return { success: true, jobs };
}
