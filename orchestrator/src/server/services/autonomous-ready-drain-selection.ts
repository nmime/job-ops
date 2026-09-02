export type BlockerBucket =
  | "allowlist_policy"
  | "session_login"
  | "captcha"
  | "required_fields"
  | "no_submit_control"
  | "no_success_confirmation"
  | "invalid_url/no_domain"
  | "unsupported_source"
  | "unknown";

export type ReadyDrainCandidateRoute =
  | "email_ready"
  | "allowed_portal_domain"
  | "review_only";

export type ReadyDrainSelectionJob = {
  id: string;
  source?: string | null;
  applicationLink?: string | null;
  jobUrlDirect?: string | null;
  jobUrl?: string | null;
  readyAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  discoveredAt?: string | null;
};

type EnvLike = Record<string, string | undefined>;

export type ReadyDrainCandidateClassification = {
  route: ReadyDrainCandidateRoute;
  priority: number;
  routeUrl: string | null;
  blockerBucket?: BlockerBucket;
  blockerReason?: string;
  reasonCode?: string;
};

function parseList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeDomain(value: string): string {
  return (value.replace(/^https?:\/\//i, "").split("/")[0] ?? "")
    .toLowerCase()
    .replace(/^www\./, "")
    .trim();
}

function allowedPortalDomains(env: EnvLike = process.env): string[] {
  const configured =
    env.JOBOPS_AUTONOMOUS_PORTAL_ALLOWED_DOMAINS ??
    env.JOBOPS_FULL_AUTO_ALLOWED_DOMAINS;
  return parseList(configured ?? "ashbyhq.com,jobs.ashbyhq.com")
    .map(normalizeDomain)
    .filter(Boolean);
}

function domainMatches(host: string, domains: string[]): boolean {
  const normalizedHost = normalizeDomain(host);
  return domains.some(
    (domain) =>
      normalizedHost === domain || normalizedHost.endsWith(`.${domain}`),
  );
}

function isHttpUrl(value: string | null | undefined): value is string {
  return /^https?:\/\//i.test(value?.trim() ?? "");
}

function hostname(value: string | null | undefined): string {
  try {
    return new URL(value ?? "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function firstHttpApplicationUrl(job: ReadyDrainSelectionJob): string | null {
  for (const value of [job.applicationLink, job.jobUrlDirect, job.jobUrl]) {
    if (isHttpUrl(value)) return value;
  }
  return null;
}

function isSourceUrlFallback(
  job: ReadyDrainSelectionJob,
  url: string,
): boolean {
  return Boolean(
    job.jobUrl &&
      url === job.jobUrl &&
      job.applicationLink !== url &&
      job.jobUrlDirect !== url,
  );
}

function isSourceValidated(
  source: string | null | undefined,
  env: EnvLike = process.env,
): boolean {
  const normalizedSource = String(source ?? "")
    .trim()
    .toLowerCase();
  const validatedSources = parseList(
    env.JOBOPS_AUTONOMOUS_PORTAL_VALIDATED_SOURCES,
  );
  return Boolean(
    normalizedSource &&
      (validatedSources.includes("*") ||
        validatedSources.includes(normalizedSource)),
  );
}

function isSourceUrlFallbackAllowed(env: EnvLike = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(
    env.JOBOPS_AUTONOMOUS_PORTAL_ALLOW_SOURCE_URL_FALLBACK ?? "",
  );
}

function isAggregatorHost(host: string): boolean {
  return /(^|\.)(linkedin|indeed|remoteok|jobicy|remotive|arbeitnow|weworkremotely|themuse|hiring\.cafe|workingnomads|startupjobs|wellfound|otta|cord|glassdoor|monster|ziprecruiter)\./i.test(
    host,
  );
}

function isSessionLoginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const query = parsed.search.toLowerCase();
  return (
    (host.endsWith("linkedin.com") &&
      (/(signup|login|uas\/login|checkpoint)\b/.test(path) ||
        path.includes("/signup/") ||
        path.includes("/login") ||
        query.includes("session_redirect="))) ||
    (/(^|\.)indeed\./.test(host) &&
      (/(account|auth|login|signin|signup|viewjob)\b/.test(path) ||
        query.includes("from=signin"))) ||
    /(login|signin|sign-in|signup|sign-up|register|account)\b/.test(path)
  );
}

function readyPriorityTimestamp(job: ReadyDrainSelectionJob): number {
  const value =
    job.readyAt ?? job.updatedAt ?? job.createdAt ?? job.discoveredAt;
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function isExplicitReviewOnlyMutationEnabled(
  env: EnvLike = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(
    env.JOBOPS_AUTONOMOUS_DRAIN_MUTATE_BLOCKED_PORTALS ?? "",
  );
}

export function classifyReadyDrainCandidate(
  job: ReadyDrainSelectionJob,
  options: { hasEmailReady?: boolean; env?: EnvLike } = {},
): ReadyDrainCandidateClassification {
  if (options.hasEmailReady) {
    return {
      route: "email_ready",
      priority: 0,
      routeUrl: job.applicationLink?.startsWith("mailto:")
        ? job.applicationLink
        : null,
    };
  }

  const routeUrl = firstHttpApplicationUrl(job);
  if (!routeUrl) {
    return {
      route: "review_only",
      priority: 2,
      routeUrl: null,
      blockerBucket: "unknown",
      blockerReason: "no_http_application_route",
    };
  }

  const host = hostname(routeUrl);
  if (!host) {
    return {
      route: "review_only",
      priority: 2,
      routeUrl,
      blockerBucket: "invalid_url/no_domain",
      blockerReason: "portal_url_missing_or_invalid",
      reasonCode: "portal_blocked_domain_not_validated",
    };
  }

  if (isSessionLoginUrl(routeUrl)) {
    return {
      route: "review_only",
      priority: 2,
      routeUrl,
      blockerBucket: "session_login",
      blockerReason: "session_required",
      reasonCode: "portal_needs_review_session_missing",
    };
  }

  if (isAggregatorHost(host)) {
    return {
      route: "review_only",
      priority: 2,
      routeUrl,
      blockerBucket: "unsupported_source",
      blockerReason: "aggregator_listing_url",
      reasonCode: "portal_blocked_unsupported_source",
    };
  }

  if (!domainMatches(host, allowedPortalDomains(options.env))) {
    return {
      route: "review_only",
      priority: 2,
      routeUrl,
      blockerBucket: "allowlist_policy",
      blockerReason: "domain_not_allowlisted",
      reasonCode: "portal_blocked_domain_not_validated",
    };
  }

  if (
    isSourceUrlFallback(job, routeUrl) &&
    !isSourceValidated(job.source, options.env) &&
    !isSourceUrlFallbackAllowed(options.env)
  ) {
    return {
      route: "review_only",
      priority: 2,
      routeUrl,
      blockerBucket: "unsupported_source",
      blockerReason: "unsupported_source",
      reasonCode: "portal_blocked_unsupported_source",
    };
  }

  return {
    route: "allowed_portal_domain",
    priority: 1,
    routeUrl,
  };
}

export function selectReadyDrainBatch<T extends ReadyDrainSelectionJob>(
  jobs: T[],
  limit: number,
  options: { hasEmailReady?: (job: T) => boolean; env?: EnvLike } = {},
): T[] {
  const boundedLimit = Math.max(1, Math.min(3, limit || 1));
  return [...jobs]
    .sort((left, right) => {
      const leftClass = classifyReadyDrainCandidate(left, {
        env: options.env,
        hasEmailReady: options.hasEmailReady?.(left),
      });
      const rightClass = classifyReadyDrainCandidate(right, {
        env: options.env,
        hasEmailReady: options.hasEmailReady?.(right),
      });
      if (leftClass.priority !== rightClass.priority) {
        return leftClass.priority - rightClass.priority;
      }
      return readyPriorityTimestamp(right) - readyPriorityTimestamp(left);
    })
    .slice(0, boundedLimit);
}
