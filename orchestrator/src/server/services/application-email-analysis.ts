export type RecipientCandidateCategory =
  | "mailto"
  | "explicit_application"
  | "alternate_application"
  | "generic_contact"
  | "low_priority"
  | "stale";

export type RecipientCandidate = {
  address: string;
  score: number;
  category: RecipientCandidateCategory;
  reason: string;
  source: string;
  stale: boolean;
};

export type InboundApplicationEmailAnalysis = {
  hasBounceOrStaleSignal: boolean;
  hasAlternateRecipient: boolean;
  candidates: RecipientCandidate[];
  reasons: string[];
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ROLE_MAILBOX_RE =
  /^(jobs?|careers?|talent|recruit(?:ing|er|ment)?|apply|application|hiring|people|hr)([+._-]|$)/i;
const LOW_PRIORITY_RE =
  /^(?:no-?reply|donotreply|support|help|hello|info|contact|admin|webmaster)([+._-]|$)/i;
const FREE_MAIL_RE =
  /^(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|protonmail)\./i;
const APPLICATION_CONTEXT_RE =
  /\b(apply|application|submit|send|resume|résumé|cv|cover\s*letter|candidate|hiring|role|position|job)\b/i;
const ALTERNATE_CONTEXT_RE =
  /\b(instead|alternate|alternative|use|contact|send|submit|forward|another|correct|updated|new)\b/i;
const STALE_CONTEXT_RE =
  /\b(no\s*longer|not\s+monitored|unmonitored|do\s+not\s+reply|don'?t\s+reply|inactive|closed|expired|outdated|old\s+address|wrong\s+address|bounced?|undeliverable|delivery\s+failed)\b/i;
const REPLY_COMMENT_RE =
  /\b(i\s+am\s+interested|interested\s+in\s+this|my\s+wheelhouse|i\s+build|i\s+have\s+experience|sent\s+you|dm\s+me|reach\s+out\s+to\s+me)\b/i;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeRecipientAddress(value: string): string | null {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

export function redactEmailAddress(
  value: string | null | undefined,
): string | null {
  const address = value ? normalizeRecipientAddress(value) : null;
  if (!address) return null;
  const [, domain] = address.split("@");
  return `***@${domain}`;
}

function surroundingText(text: string, index: number, length: number): string {
  return text.slice(
    Math.max(0, index - 120),
    Math.min(text.length, index + length + 160),
  );
}

function sentenceAroundEmail(
  text: string,
  index: number,
  length: number,
): string {
  const start = Math.max(
    text.lastIndexOf(".", index - 1),
    text.lastIndexOf("!", index - 1),
    text.lastIndexOf("?", index - 1),
    text.lastIndexOf("\n", index - 1),
  );
  const endCandidates = [".", "!", "?", "\n"]
    .map((token) => text.indexOf(token, index + length))
    .filter((value) => value >= 0);
  const end =
    endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
  return text.slice(start + 1, end + 1);
}

function categoryFor(args: {
  source: string;
  local: string;
  domain: string;
  context: string;
  explicitApplication: boolean;
  stale: boolean;
}): RecipientCandidateCategory {
  if (args.stale) return "stale";
  if (args.source === "applicationLink" || /^mailto:/i.test(args.context))
    return "mailto";
  if (
    APPLICATION_CONTEXT_RE.test(args.context) &&
    ALTERNATE_CONTEXT_RE.test(args.context)
  ) {
    return "alternate_application";
  }
  if (args.explicitApplication) return "explicit_application";
  if (LOW_PRIORITY_RE.test(args.local) || FREE_MAIL_RE.test(args.domain))
    return "low_priority";
  return "generic_contact";
}

function scoreCandidate(
  candidate: Omit<RecipientCandidate, "score" | "reason">,
): number {
  const [local = "", domain = ""] = candidate.address.split("@");
  let score = 35;
  if (candidate.category === "mailto") score += 45;
  if (candidate.category === "alternate_application") score += 55;
  if (candidate.category === "explicit_application") score += 35;
  if (ROLE_MAILBOX_RE.test(local)) score += 25;
  if (APPLICATION_CONTEXT_RE.test(candidate.source)) score += 5;
  if (LOW_PRIORITY_RE.test(local)) score -= 30;
  if (FREE_MAIL_RE.test(domain)) score -= 15;
  if (
    FREE_MAIL_RE.test(domain) &&
    APPLICATION_CONTEXT_RE.test(candidate.source)
  )
    score += 10;
  if (candidate.stale) score -= 100;
  return score;
}

function collectFromText(
  text: string,
  source: string,
  map: Map<string, RecipientCandidate>,
) {
  for (const match of text.matchAll(EMAIL_RE)) {
    const address = normalizeRecipientAddress(match[0]);
    if (!address) continue;
    const [local = "", domain = ""] = address.split("@");
    const context = surroundingText(text, match.index ?? 0, match[0].length);
    const sentenceContext = sentenceAroundEmail(
      text,
      match.index ?? 0,
      match[0].length,
    );
    const stale = STALE_CONTEXT_RE.test(sentenceContext);
    const explicitApplication = APPLICATION_CONTEXT_RE.test(context);
    const category = categoryFor({
      source,
      local,
      domain,
      context,
      explicitApplication,
      stale,
    });
    const base = { address, category, source, stale };
    const score = scoreCandidate(base);
    const reason = `${category}:${source}`;
    const existing = map.get(address);
    if (!existing || score > existing.score) {
      map.set(address, { ...base, score, reason });
    }
  }
}

function collectMailto(
  value: string,
  source: string,
  map: Map<string, RecipientCandidate>,
) {
  for (const match of value.matchAll(/mailto:([^?\s"'<>]+)/gi)) {
    const decoded = decodeURIComponent(match[1] ?? "");
    collectFromText(`mailto:${decoded}`, source, map);
  }
}

export function extractRecipientCandidates(input: {
  applicationLink?: string | null;
  emails?: string | null;
  jobDescription?: string | null;
  jobBrief?: string | null;
  replyText?: string | null;
}): RecipientCandidate[] {
  const candidates = new Map<string, RecipientCandidate>();
  const fields = [
    ["applicationLink", clean(input.applicationLink)],
    ["emails", clean(input.emails)],
    ["jobDescription", clean(input.jobDescription)],
    ["jobBrief", clean(input.jobBrief)],
    ["replyText", clean(input.replyText)],
  ] as const;

  for (const [source, value] of fields) {
    if (!value) continue;
    collectMailto(value, source, candidates);
    collectFromText(value, source, candidates);
  }

  return Array.from(candidates.values())
    .filter((candidate) => !candidate.stale)
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

export function chooseApplicationRecipient(input: {
  applicationLink?: string | null;
  emails?: string | null;
  jobDescription?: string | null;
  jobBrief?: string | null;
}): RecipientCandidate | null {
  return extractRecipientCandidates(input)[0] ?? null;
}

export function analyzeInboundApplicationEmail(input: {
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
}): InboundApplicationEmailAnalysis {
  const text = [input.subject, input.snippet, input.body]
    .map(clean)
    .filter(Boolean)
    .join("\n");
  const candidates = extractRecipientCandidates({ replyText: text });
  const hasBounceOrStaleSignal = STALE_CONTEXT_RE.test(text);
  const hasAlternateRecipient = candidates.some(
    (candidate) =>
      candidate.category === "alternate_application" ||
      candidate.category === "explicit_application",
  );
  const reasons = [
    ...(hasBounceOrStaleSignal ? ["bounce_or_stale_signal"] : []),
    ...(hasAlternateRecipient ? ["alternate_recipient_detected"] : []),
  ];
  return { hasBounceOrStaleSignal, hasAlternateRecipient, candidates, reasons };
}

export function looksLikeHnCandidateReply(text: string): boolean {
  return (
    REPLY_COMMENT_RE.test(text) &&
    !/\b(we\s+are\s+hiring|we'?re\s+hiring|hiring\s+(?:for|a)|join\s+our\s+team)\b/i.test(
      text,
    )
  );
}

export function looksStaleApplicationText(text: string): boolean {
  return (
    STALE_CONTEXT_RE.test(text) &&
    !APPLICATION_CONTEXT_RE.test(text.replace(STALE_CONTEXT_RE, ""))
  );
}
