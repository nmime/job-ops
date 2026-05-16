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
  "remoteok",
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "telegram",
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
  greenhouseBoardTokens?: string[];
  leverSites?: string[];
  leverEuSites?: string[];
  leverUseEu?: boolean;
  ashbyJobBoardNames?: string[];
  smartrecruitersCompanies?: string[];
  telegramChannels?: string[];
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

function asObject(value: unknown): RawJob | undefined {
  return value && typeof value === "object" ? (value as RawJob) : undefined;
}

function asDateString(value: unknown): string | undefined {
  const stringValue = asString(value);
  if (stringValue) return stringValue;
  const numberValue = asNumber(value);
  if (numberValue === undefined) return undefined;
  const date = new Date(numberValue);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return decodeHtml(
    value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
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
      accept: "application/rss+xml, application/xml, text/xml, text/html, */*",
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

function mapRemoteOkJob(job: RawJob): CreateJobInput | null {
  return buildJob({
    source: "remoteok",
    sourceJobId: String(job.id ?? job.slug ?? "") || undefined,
    title: asString(job.position) ?? asString(job.title),
    employer: asString(job.company),
    jobUrl: asString(job.url),
    applicationLink: asString(job.apply_url) ?? asString(job.url),
    location: asString(job.location) ?? "Remote",
    datePosted: asString(job.date) ?? asString(job.epoch),
    description: asString(job.description),
    jobType: asString(job.job_type),
    jobFunction: asString(job.category),
    skills: asStringArray(job.tags),
    salaryMinAmount: asNumber(job.salary_min),
    salaryMaxAmount: asNumber(job.salary_max),
    salaryCurrency: asString(job.salary_currency),
    companyLogo: asString(job.company_logo) ?? asString(job.logo),
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

function objectString(value: unknown, key: string): string | undefined {
  return asString(asObject(value)?.[key]);
}

function objectNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asString(item) ?? objectString(item, "name"))
    .filter((item): item is string => Boolean(item));
}

function mapGreenhouseJob(job: RawJob): CreateJobInput | null {
  const location =
    objectString(job.location, "name") || objectNames(job.offices).join(", ") || undefined;
  const departments = objectNames(job.departments);

  return buildJob({
    source: "greenhouse",
    sourceJobId: String(job.id ?? job.internal_job_id ?? "") || undefined,
    title: asString(job.title),
    employer:
      asString(job.company_name) ??
      asString(job.company) ??
      asString(job._boardToken) ??
      "Greenhouse board",
    jobUrl: asString(job.absolute_url) ?? asString(job.url),
    applicationLink: asString(job.absolute_url) ?? asString(job.url),
    location,
    datePosted:
      asDateString(job.updated_at) ?? asDateString(job.first_published),
    description: asString(job.content),
    jobFunction: departments.join(", ") || undefined,
  });
}

function mapLeverJob(job: RawJob): CreateJobInput | null {
  const categories = asObject(job.categories) ?? {};
  const lists = Array.isArray(job.lists) ? job.lists : [];
  const listDescription = lists
    .map((item) => {
      const object = asObject(item);
      return [objectString(object, "text"), objectString(object, "content")]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");

  return buildJob({
    source: "lever",
    sourceJobId: asString(job.id),
    title: asString(job.text) ?? asString(job.title),
    employer: asString(job.company) ?? asString(job._site) ?? "Lever site",
    jobUrl: asString(job.hostedUrl) ?? asString(job.url),
    applicationLink: asString(job.applyUrl) ?? asString(job.hostedUrl),
    location: asString(categories.location) ?? asString(job.location),
    datePosted: asDateString(job.createdAt) ?? asDateString(job.updatedAt),
    description:
      asString(job.descriptionPlain) ??
      asString(job.description) ??
      listDescription,
    jobType: asString(categories.commitment),
    jobFunction: asString(categories.team) ?? asString(categories.department),
    skills: asStringArray(job.tags),
  });
}

function mapAshbyJob(job: RawJob): CreateJobInput | null {
  const compensation = asObject(job.compensation) ?? {};
  const location =
    asString(job.location) ??
    objectString(job.location, "name") ??
    objectString(job.location, "location");

  return buildJob({
    source: "ashby",
    sourceJobId: asString(job.id),
    title: asString(job.title),
    employer:
      asString(job.companyName) ??
      asString(job.organizationName) ??
      asString(job._boardName) ??
      "Ashby board",
    jobUrl: asString(job.jobUrl) ?? asString(job.url),
    applicationLink:
      asString(job.applyUrl) ??
      asString(job.applicationUrl) ??
      asString(job.jobUrl),
    location,
    datePosted: asDateString(job.publishedDate) ?? asDateString(job.updatedAt),
    description:
      asString(job.descriptionPlain) ?? asString(job.descriptionHtml),
    jobType: asString(job.employmentType),
    jobFunction:
      asString(job.department) ?? objectString(job.department, "name"),
    salary:
      asString(compensation.compensationTierSummary) ??
      asString(compensation.summary),
    salaryCurrency: asString(compensation.currencyCode),
  });
}

function mapSmartRecruitersJob(job: RawJob): CreateJobInput | null {
  const company = asObject(job.company) ?? {};
  const location = asObject(job.location) ?? {};
  const jobAd = asObject(job.jobAd) ?? {};
  const sections = asObject(jobAd.sections) ?? {};
  const companyIdentifier = asString(job._companyIdentifier);
  const sourceJobId = String(job.id ?? job.uuid ?? job.ref ?? "") || undefined;
  const fallbackUrl =
    companyIdentifier && sourceJobId
      ? `https://jobs.smartrecruiters.com/${encodeURIComponent(companyIdentifier)}/${encodeURIComponent(sourceJobId)}`
      : undefined;
  const joinedLocation = [
    asString(location.city),
    asString(location.region),
    asString(location.country),
  ]
    .filter(Boolean)
    .join(", ");

  return buildJob({
    source: "smartrecruiters",
    sourceJobId,
    title: asString(job.name) ?? asString(job.title),
    employer:
      asString(company.name) ?? companyIdentifier ?? "SmartRecruiters company",
    jobUrl:
      asString(job.postingUrl) ??
      asString(job.applyUrl) ??
      asString(job.url) ??
      fallbackUrl,
    applicationLink:
      asString(job.applyUrl) ?? asString(job.postingUrl) ?? fallbackUrl,
    location: joinedLocation || objectString(job.location, "fullLocation"),
    datePosted: asDateString(job.releasedDate) ?? asDateString(job.updatedOn),
    description: [
      asString(sections.jobDescription),
      asString(sections.qualifications),
      asString(sections.additionalInformation),
      asString(job.description),
    ]
      .filter(Boolean)
      .join("\n\n"),
    jobType:
      objectString(job.typeOfEmployment, "label") ??
      asString(job.typeOfEmployment),
    jobFunction: objectString(job.function, "label") ?? asString(job.function),
    jobLevel:
      objectString(job.experienceLevel, "label") ??
      asString(job.experienceLevel),
  });
}

function normalizeTelegramChannel(channel: string): string | undefined {
  const trimmed = channel.trim();
  if (!trimmed) return undefined;
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const match =
    /^(?:t\.me\/s\/|t\.me\/|telegram\.me\/|@)?([a-zA-Z0-9_]{5,})/.exec(
      withoutProtocol,
    );
  return match?.[1];
}

function telegramChannels(channels: string[] | undefined): string[] {
  const normalized = (channels?.length ? channels : ["nodejsjobsfeed"])
    .map(normalizeTelegramChannel)
    .filter((item): item is string => Boolean(item));
  return [...new Set(normalized)];
}

function attributeValue(html: string, attribute: string): string | undefined {
  const pattern = new RegExp(`${attribute}=["']([^"']+)["']`, "i");
  const match = pattern.exec(html);
  return match?.[1] ? decodeHtml(match[1]) : undefined;
}

function linksFromHtml(html: string): { href: string; text: string }[] {
  return [
    ...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  ]
    .map((match) => ({
      href: decodeHtml(match[1] ?? "").trim(),
      text: stripHtml(match[2] ?? "") ?? "",
    }))
    .filter((link) => link.href.length > 0);
}

function isExternalTelegramLink(href: string): boolean {
  return (
    /^https?:\/\//i.test(href) &&
    !/^https?:\/\/(?:t|telegram)\.me\//i.test(href)
  );
}

function parseTelegramMessages(html: string, channel: string): RawJob[] {
  return [
    ...html.matchAll(
      /<div\b[^>]*class=["'][^"']*\btgme_widget_message\b[\s\S]*?(?=<div\b[^>]*class=["'][^"']*\btgme_widget_message\b|<\/section>|$)/gi,
    ),
  ]
    .map((match): RawJob | undefined => {
      const block = match[0];
      const textMatch =
        /<div\b[^>]*class=["'][^"']*\btgme_widget_message_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
          block,
        );
      const textHtml = textMatch?.[1] ?? "";
      const text = stripHtml(textHtml);
      if (!text) return undefined;
      const links = linksFromHtml(textHtml);
      const externalLink = links.find((link) =>
        isExternalTelegramLink(link.href),
      );
      const messageUrl =
        attributeValue(
          /<a\b[^>]*class=["'][^"']*\btgme_widget_message_date\b[\s\S]*?<\/a>/i.exec(
            block,
          )?.[0] ?? "",
          "href",
        ) ?? `https://t.me/${channel}`;
      const sourceJobId = attributeValue(block, "data-post") ?? messageUrl;
      const firstLine =
        text
          .split(/\r?\n|\s{2,}/)
          .map((line) => line.trim())
          .find(Boolean) ?? `Telegram post from ${channel}`;
      const title =
        firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;

      return {
        _channel: channel,
        sourceJobId,
        title,
        url: messageUrl,
        applyUrl: externalLink?.href ?? messageUrl,
        text,
        linkText: externalLink?.text,
      };
    })
    .filter((job): job is RawJob => Boolean(job));
}

function mapTelegramJob(job: RawJob): CreateJobInput | null {
  return buildJob({
    source: "telegram",
    sourceJobId: asString(job.sourceJobId),
    title: asString(job.title),
    employer: asString(job._channel) ?? "Telegram channel",
    jobUrl: asString(job.url),
    applicationLink: asString(job.applyUrl) ?? asString(job.url),
    location: "Remote",
    description: asString(job.text),
    skills: asStringArray(job.linkText),
  });
}

async function fetchJsonLists(args: {
  fetchImpl: typeof fetch;
  source: RemoteApiSource;
  urls: { url: string; context: RawJob }[];
  pickJobs: (payload: unknown) => RawJob[];
}): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  for (const item of args.urls) {
    try {
      const payload = await fetchJson({
        fetchImpl: args.fetchImpl,
        source: args.source,
        url: item.url,
      });
      jobs.push(
        ...args.pickJobs(payload).map((job) => ({ ...job, ...item.context })),
      );
    } catch {
      // Keep multi-board public API sources best-effort: one retired/moved board
      // should not hide results from the rest of the configured boards.
    }
  }
  return jobs;
}

async function fetchSourceJobs(args: {
  fetchImpl: typeof fetch;
  source: RemoteApiSource;
  maxJobsPerTerm: number;
  options: RunRemoteApiJobsOptions;
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
    case "remoteok": {
      const payload = await fetchJson({
        fetchImpl: args.fetchImpl,
        source: args.source,
        url: "https://remoteok.com/api",
      });
      const jobs = Array.isArray(payload) ? (payload as RawJob[]) : [];
      return { source: args.source, jobs };
    }
    case "greenhouse": {
      const jobs = await fetchJsonLists({
        fetchImpl: args.fetchImpl,
        source: args.source,
        urls: (args.options.greenhouseBoardTokens ?? []).map((token) => ({
          url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
          context: { _boardToken: token },
        })),
        pickJobs: (payload) =>
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as RawJob).jobs)
            ? ((payload as RawJob).jobs as RawJob[])
            : [],
      });
      return { source: args.source, jobs };
    }
    case "lever": {
      const useEu = args.options.leverUseEu === true;
      const sites = args.options.leverSites ?? [];
      const euSites = args.options.leverEuSites ?? [];
      const urls = [
        ...sites.map((site) => ({
          url: `${useEu ? "https://api.eu.lever.co" : "https://api.lever.co"}/v0/postings/${encodeURIComponent(site)}?mode=json`,
          context: { _site: site },
        })),
        ...euSites.map((site) => ({
          url: `https://api.eu.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`,
          context: { _site: site },
        })),
      ];
      const jobs = await fetchJsonLists({
        fetchImpl: args.fetchImpl,
        source: args.source,
        urls,
        pickJobs: (payload) =>
          Array.isArray(payload) ? (payload as RawJob[]) : [],
      });
      return { source: args.source, jobs };
    }
    case "ashby": {
      const jobs = await fetchJsonLists({
        fetchImpl: args.fetchImpl,
        source: args.source,
        urls: (args.options.ashbyJobBoardNames ?? []).map((name) => ({
          url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}?includeCompensation=true`,
          context: { _boardName: name },
        })),
        pickJobs: (payload) =>
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as RawJob).jobs)
            ? ((payload as RawJob).jobs as RawJob[])
            : [],
      });
      return { source: args.source, jobs };
    }
    case "smartrecruiters": {
      const jobs = await fetchJsonLists({
        fetchImpl: args.fetchImpl,
        source: args.source,
        urls: (args.options.smartrecruitersCompanies ?? []).map((company) => ({
          url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=100`,
          context: { _companyIdentifier: company },
        })),
        pickJobs: (payload) =>
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as RawJob).content)
            ? ((payload as RawJob).content as RawJob[])
            : [],
      });
      return { source: args.source, jobs };
    }
    case "telegram": {
      const jobs: RawJob[] = [];
      for (const channel of telegramChannels(args.options.telegramChannels)) {
        try {
          const html = await fetchText({
            fetchImpl: args.fetchImpl,
            source: args.source,
            url: `https://t.me/s/${encodeURIComponent(channel)}`,
          });
          jobs.push(...parseTelegramMessages(html, channel));
        } catch {
          // Public channel pages can disappear or rate-limit; keep this best-effort.
        }
      }
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
    case "remoteok":
      return mapRemoteOkJob(job);
    case "greenhouse":
      return mapGreenhouseJob(job);
    case "lever":
      return mapLeverJob(job);
    case "ashby":
      return mapAshbyJob(job);
    case "smartrecruiters":
      return mapSmartRecruitersJob(job);
    case "telegram":
      return mapTelegramJob(job);
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
        await fetchSourceJobs({
          fetchImpl,
          source,
          maxJobsPerTerm,
          options,
        }),
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
