import {
  matchesRequestedCity,
  normalizeLocationToken,
  resolveSearchCities,
} from "job-ops-shared/search-cities";
import type {
  CreateJobInput,
  JobLocationEvidence,
} from "job-ops-shared/types/jobs";

export const REMOTE_API_SOURCES = [
  "remotive",
  "jobicy",
  "weworkremotely",
  "themuse",
  "arbeitnow",
] as const;

export type RemoteApiSource = (typeof REMOTE_API_SOURCES)[number];
export type RemoteApiWorkplaceType = "remote" | "hybrid" | "onsite";

export type RemoteApiProgressEvent =
  | {
      type: "term_start";
      source: RemoteApiSource;
      termIndex: number;
      termTotal: number;
      searchTerm: string;
    }
  | {
      type: "term_complete";
      source: RemoteApiSource;
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      jobsFoundTerm: number;
    };

export interface RunRemoteApiJobsOptions {
  selectedSources?: RemoteApiSource[];
  searchTerms?: string[];
  selectedCountry?: string;
  locations?: string[];
  workplaceTypes?: RemoteApiWorkplaceType[];
  maxJobsPerTerm?: number;
  onProgress?: (event: RemoteApiProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface RemoteApiJobsResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
}

type RawJob = Record<string, unknown>;

type FetchedSourceJobs = {
  source: RemoteApiSource;
  jobs: RawJob[];
};

function toPositiveIntOrFallback(
  value: number | string | undefined,
  fallback: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((item): item is string => Boolean(item));
  }
  const stringValue = asString(value);
  if (!stringValue) return [];
  return stringValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesSearchTerm(job: CreateJobInput, searchTerm: string): boolean {
  const normalizedTerm = normalizeText(searchTerm);
  if (!normalizedTerm) return true;

  const haystack = normalizeText(
    [
      job.title,
      job.employer,
      job.location,
      job.jobDescription,
      job.disciplines,
      job.skills,
      job.jobFunction,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (!haystack) return false;
  if (haystack.includes(normalizedTerm)) return true;

  return normalizedTerm
    .split(" ")
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function matchesRequestedLocation(
  location: string | undefined,
  requestedLocation: string,
): boolean {
  if (!location) return false;
  if (matchesRequestedCity(location, requestedLocation)) return true;

  const normalizedLocation = normalizeLocationToken(location);
  const normalizedRequestedLocation = normalizeLocationToken(requestedLocation);
  if (!normalizedLocation || !normalizedRequestedLocation) return false;

  return normalizedLocation.includes(normalizedRequestedLocation);
}

function matchesWorkplaceTypes(
  workplaceTypes: RemoteApiWorkplaceType[] | undefined,
): boolean {
  if (!workplaceTypes || workplaceTypes.length === 0) return true;
  return workplaceTypes.includes("remote");
}

function locationEvidence(
  location: string | undefined,
  source: RemoteApiSource,
): JobLocationEvidence | undefined {
  return {
    location: location ?? "Remote",
    workplaceType: "remote",
    isRemote: true,
    source,
  };
}

function mapSalary(args: {
  salary?: string;
  min?: number;
  max?: number;
  currency?: string;
}): string | undefined {
  if (args.salary) return args.salary;
  if (!args.min && !args.max) return undefined;
  const currency = args.currency ?? "";
  if (args.min && args.max)
    return `${currency}${args.min} - ${currency}${args.max}`;
  if (args.min) return `${currency}${args.min}+`;
  return `${currency}${args.max}`;
}

function buildJob(args: {
  source: RemoteApiSource;
  sourceJobId?: string;
  title?: string;
  employer?: string;
  jobUrl?: string;
  applicationLink?: string;
  location?: string;
  datePosted?: string;
  description?: string;
  jobType?: string;
  jobFunction?: string;
  skills?: string[];
  salary?: string;
  salaryMinAmount?: number;
  salaryMaxAmount?: number;
  salaryCurrency?: string;
  companyLogo?: string;
  companyUrl?: string;
  jobLevel?: string;
}): CreateJobInput | null {
  if (!args.title || !args.employer || !args.jobUrl) return null;
  const skills = args.skills?.filter(Boolean) ?? [];

  return {
    source: args.source,
    sourceJobId: args.sourceJobId,
    title: args.title,
    employer: args.employer,
    jobUrl: args.jobUrl,
    applicationLink: args.applicationLink ?? args.jobUrl,
    location: args.location ?? "Remote",
    locationEvidence: locationEvidence(args.location, args.source),
    datePosted: args.datePosted,
    jobDescription: stripHtml(args.description),
    jobType: args.jobType,
    jobFunction: args.jobFunction,
    disciplines: skills.length > 0 ? skills.join(", ") : args.jobFunction,
    skills: skills.length > 0 ? skills.join(", ") : undefined,
    salary: mapSalary({
      salary: args.salary,
      min: args.salaryMinAmount,
      max: args.salaryMaxAmount,
      currency: args.salaryCurrency,
    }),
    salaryMinAmount: args.salaryMinAmount,
    salaryMaxAmount: args.salaryMaxAmount,
    salaryCurrency: args.salaryCurrency,
    companyLogo: args.companyLogo,
    companyUrlDirect: args.companyUrl,
    isRemote: true,
    jobLevel: args.jobLevel,
  };
}

async function fetchJson(args: {
  fetchImpl: typeof fetch;
  url: string;
  source: RemoteApiSource;
}): Promise<unknown> {
  const response = await args.fetchImpl(args.url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "job-ops/1.0 (+https://github.com/nmime/job-ops)",
    },
  });

  if (!response.ok) {
    throw new Error(`${args.source} request failed with ${response.status}`);
  }

  return response.json();
}

async function fetchText(args: {
  fetchImpl: typeof fetch;
  url: string;
  source: RemoteApiSource;
}): Promise<string> {
  const response = await args.fetchImpl(args.url, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml, */*",
      "user-agent": "job-ops/1.0 (+https://github.com/nmime/job-ops)",
    },
  });

  if (!response.ok) {
    throw new Error(`${args.source} request failed with ${response.status}`);
  }

  return response.text();
}

function mapRemotiveJob(job: RawJob): CreateJobInput | null {
  return buildJob({
    source: "remotive",
    sourceJobId: String(job.id ?? "") || undefined,
    title: asString(job.title),
    employer: asString(job.company_name),
    jobUrl: asString(job.url),
    applicationLink: asString(job.url),
    location: asString(job.candidate_required_location),
    datePosted: asString(job.publication_date),
    description: asString(job.description),
    jobType: asString(job.job_type),
    jobFunction: asString(job.category),
    skills: asStringArray(job.tags),
    salary: asString(job.salary),
    companyLogo: asString(job.company_logo),
  });
}

function mapJobicyJob(job: RawJob): CreateJobInput | null {
  return buildJob({
    source: "jobicy",
    sourceJobId: String(job.id ?? job.jobSlug ?? "") || undefined,
    title: asString(job.jobTitle),
    employer: asString(job.companyName),
    jobUrl: asString(job.url),
    applicationLink: asString(job.url),
    location: asString(job.jobGeo),
    datePosted: asString(job.pubDate),
    description: asString(job.jobDescription) ?? asString(job.jobExcerpt),
    jobType: asString(job.jobType),
    jobFunction: asString(job.jobIndustry),
    skills: asStringArray(job.jobTags),
    salaryMinAmount: asNumber(job.annualSalaryMin),
    salaryMaxAmount: asNumber(job.annualSalaryMax),
    salaryCurrency: asString(job.salaryCurrency),
    companyLogo: asString(job.companyLogo),
    jobLevel: asString(job.jobLevel),
  });
}

function mapMuseJob(job: RawJob): CreateJobInput | null {
  const refs = job.refs && typeof job.refs === "object" ? job.refs : {};
  const company =
    job.company && typeof job.company === "object" ? job.company : {};
  const locations = Array.isArray(job.locations) ? job.locations : [];
  const categories = Array.isArray(job.categories) ? job.categories : [];
  const levels = Array.isArray(job.levels) ? job.levels : [];
  const tags = Array.isArray(job.tags) ? job.tags : [];

  return buildJob({
    source: "themuse",
    sourceJobId: String(job.id ?? "") || undefined,
    title: asString(job.name),
    employer: asString((company as RawJob).name),
    jobUrl: asString((refs as RawJob).landing_page),
    applicationLink: asString((refs as RawJob).landing_page),
    location:
      locations
        .map((item) =>
          item && typeof item === "object"
            ? asString((item as RawJob).name)
            : undefined,
        )
        .filter(Boolean)
        .join(", ") || "Remote",
    datePosted: asString(job.publication_date),
    description: asString(job.contents),
    jobFunction:
      categories
        .map((item) =>
          item && typeof item === "object"
            ? asString((item as RawJob).name)
            : undefined,
        )
        .filter(Boolean)
        .join(", ") || undefined,
    skills: tags
      .map((item) =>
        item && typeof item === "object"
          ? asString((item as RawJob).name)
          : undefined,
      )
      .filter((item): item is string => Boolean(item)),
    jobLevel:
      levels
        .map((item) =>
          item && typeof item === "object"
            ? asString((item as RawJob).name)
            : undefined,
        )
        .filter(Boolean)
        .join(", ") || undefined,
  });
}

function mapArbeitnowJob(job: RawJob): CreateJobInput | null {
  return buildJob({
    source: "arbeitnow",
    sourceJobId: asString(job.slug),
    title: asString(job.title),
    employer: asString(job.company_name),
    jobUrl: asString(job.url),
    applicationLink: asString(job.url),
    location: asString(job.location) ?? "Remote",
    datePosted: asString(job.created_at),
    description: asString(job.description),
    jobType: asStringArray(job.job_types).join(", ") || undefined,
    skills: asStringArray(job.tags),
  });
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function xmlTag(item: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(
    item,
  );
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function parseWwrItems(xml: string): RawJob[] {
  return [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map((match) => {
    const item = match[0];
    return {
      title: xmlTag(item, "title"),
      url: xmlTag(item, "link"),
      description: xmlTag(item, "description"),
      pubDate: xmlTag(item, "pubDate"),
      categories: [
        ...item.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi),
      ].map((category) => decodeXml(category[1] ?? "")),
    };
  });
}

function mapWwrJob(job: RawJob): CreateJobInput | null {
  const rawTitle = asString(job.title);
  const splitTitle = rawTitle?.match(
    /^(.+?)\s+is hiring\s+(?:a\s+|an\s+)?(.+)$/i,
  );
  const employer = splitTitle?.[1]?.trim();
  const title = splitTitle?.[2]?.trim() ?? rawTitle;
  const categories = asStringArray(job.categories);

  return buildJob({
    source: "weworkremotely",
    sourceJobId: asString(job.url),
    title,
    employer: employer ?? "Unknown Employer",
    jobUrl: asString(job.url),
    applicationLink: asString(job.url),
    location: "Remote",
    datePosted: asString(job.pubDate),
    description: asString(job.description),
    skills: categories,
  });
}

async function fetchSourceJobs(args: {
  fetchImpl: typeof fetch;
  source: RemoteApiSource;
  maxJobsPerTerm: number;
}): Promise<FetchedSourceJobs> {
  switch (args.source) {
    case "remotive": {
      const payload = await fetchJson({
        fetchImpl: args.fetchImpl,
        source: args.source,
        url: "https://remotive.com/api/remote-jobs?limit=100",
      });
      const jobs =
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as RawJob).jobs)
          ? ((payload as RawJob).jobs as RawJob[])
          : [];
      return { source: args.source, jobs };
    }
    case "jobicy": {
      const payload = await fetchJson({
        fetchImpl: args.fetchImpl,
        source: args.source,
        url: `https://jobicy.com/api/v2/remote-jobs?count=${Math.max(args.maxJobsPerTerm * 4, 50)}`,
      });
      const jobs =
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as RawJob).jobs)
          ? ((payload as RawJob).jobs as RawJob[])
          : [];
      return { source: args.source, jobs };
    }
    case "weworkremotely": {
      const xml = await fetchText({
        fetchImpl: args.fetchImpl,
        source: args.source,
        url: "https://weworkremotely.com/categories/remote-programming-jobs.rss",
      });
      return { source: args.source, jobs: parseWwrItems(xml) };
    }
    case "themuse": {
      const payload = await fetchJson({
        fetchImpl: args.fetchImpl,
        source: args.source,
        url: "https://www.themuse.com/api/public/jobs?page=1&location=Remote",
      });
      const jobs =
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as RawJob).results)
          ? ((payload as RawJob).results as RawJob[])
          : [];
      return { source: args.source, jobs };
    }
    case "arbeitnow": {
      const payload = await fetchJson({
        fetchImpl: args.fetchImpl,
        source: args.source,
        url: "https://www.arbeitnow.com/api/job-board-api?remote=true",
      });
      const jobs =
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as RawJob).data)
          ? ((payload as RawJob).data as RawJob[])
          : [];
      return { source: args.source, jobs };
    }
  }
}

function mapSourceJob(
  source: RemoteApiSource,
  job: RawJob,
): CreateJobInput | null {
  switch (source) {
    case "remotive":
      return mapRemotiveJob(job);
    case "jobicy":
      return mapJobicyJob(job);
    case "weworkremotely":
      return mapWwrJob(job);
    case "themuse":
      return mapMuseJob(job);
    case "arbeitnow":
      return mapArbeitnowJob(job);
  }
}

export async function runRemoteApiJobs(
  options: RunRemoteApiJobsOptions = {},
): Promise<RemoteApiJobsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const selectedSources = options.selectedSources?.length
    ? options.selectedSources
    : [...REMOTE_API_SOURCES];
  const searchTerms = options.searchTerms?.length
    ? options.searchTerms
    : ["software engineer"];
  const maxJobsPerTerm = toPositiveIntOrFallback(options.maxJobsPerTerm, 50);
  const explicitLocations = resolveSearchCities({ list: options.locations });

  if (!matchesWorkplaceTypes(options.workplaceTypes)) {
    return { success: true, jobs: [] };
  }

  try {
    const jobs: CreateJobInput[] = [];
    const seen = new Set<string>();
    const fetchedSources: FetchedSourceJobs[] = [];

    for (const source of selectedSources) {
      if (options.shouldCancel?.()) return { success: true, jobs };
      fetchedSources.push(
        await fetchSourceJobs({ fetchImpl, source, maxJobsPerTerm }),
      );
    }

    const termTotal = fetchedSources.length * searchTerms.length;
    let termIndex = 0;

    for (const fetchedSource of fetchedSources) {
      const mappedJobs = fetchedSource.jobs
        .map((job) => mapSourceJob(fetchedSource.source, job))
        .filter((job): job is CreateJobInput => Boolean(job));

      for (const searchTerm of searchTerms) {
        termIndex += 1;
        if (options.shouldCancel?.()) return { success: true, jobs };

        options.onProgress?.({
          type: "term_start",
          source: fetchedSource.source,
          termIndex,
          termTotal,
          searchTerm,
        });

        let jobsFoundTerm = 0;
        for (const mapped of mappedJobs) {
          if (options.shouldCancel?.()) return { success: true, jobs };
          if (jobsFoundTerm >= maxJobsPerTerm) break;
          if (!matchesSearchTerm(mapped, searchTerm)) continue;
          if (
            explicitLocations.length > 0 &&
            !explicitLocations.some((location) =>
              matchesRequestedLocation(mapped.location, location),
            )
          ) {
            continue;
          }

          const dedupeKey = `${mapped.source}:${mapped.sourceJobId ?? mapped.jobUrl}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          jobs.push(mapped);
          jobsFoundTerm += 1;
        }

        options.onProgress?.({
          type: "term_complete",
          source: fetchedSource.source,
          termIndex,
          termTotal,
          searchTerm,
          jobsFoundTerm,
        });
      }
    }

    return { success: true, jobs };
  } catch (error) {
    return {
      success: false,
      jobs: [],
      error:
        error instanceof Error
          ? error.message
          : "Unexpected error while running remote API extractors.",
    };
  }
}
