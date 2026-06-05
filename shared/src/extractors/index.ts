import { z } from "zod";

export const EXTRACTOR_SOURCE_IDS = [
  "gradcracker",
  "indeed",
  "linkedin",
  "glassdoor",
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
  "himalayas",
  "hnhiring",
  "usajobs",
  "ukvisajobs",
  "adzuna",
  "hiringcafe",
  "startupjobs",
  "workingnomads",
  "golangjobs",
  "jobindex",
  "seek",
  "naukri",
  "fiveamsat",
  "wazzuf",
  "everjobs",
  "manual",
] as const;

export type ExtractorSourceId = (typeof EXTRACTOR_SOURCE_IDS)[number];

export interface ExtractorSourceMetadata {
  label: string;
  order: number;
  category: "pipeline" | "manual";
  requiresCredentials?: boolean;
  ukOnly?: boolean;
}

export const EXTRACTOR_SOURCE_METADATA: Record<
  ExtractorSourceId,
  ExtractorSourceMetadata
> = {
  gradcracker: {
    label: "Gradcracker",
    order: 10,
    category: "pipeline",
    ukOnly: true,
  },
  indeed: { label: "Indeed", order: 20, category: "pipeline" },
  linkedin: { label: "LinkedIn", order: 30, category: "pipeline" },
  glassdoor: { label: "Glassdoor", order: 40, category: "pipeline" },
  remotive: { label: "Remotive", order: 41, category: "pipeline" },
  jobicy: { label: "Jobicy", order: 42, category: "pipeline" },
  weworkremotely: {
    label: "We Work Remotely",
    order: 43,
    category: "pipeline",
  },
  themuse: { label: "The Muse", order: 44, category: "pipeline" },
  arbeitnow: { label: "Arbeitnow", order: 45, category: "pipeline" },
  remoteok: { label: "Remote OK", order: 46, category: "pipeline" },
  greenhouse: { label: "Greenhouse", order: 47, category: "pipeline" },
  lever: { label: "Lever", order: 48, category: "pipeline" },
  ashby: { label: "Ashby", order: 49, category: "pipeline" },
  smartrecruiters: {
    label: "SmartRecruiters",
    order: 50,
    category: "pipeline",
  },
  telegram: { label: "Telegram", order: 51, category: "pipeline" },
  himalayas: { label: "Himalayas", order: 52, category: "pipeline" },
  hnhiring: { label: "HN Hiring", order: 53, category: "pipeline" },
  usajobs: {
    label: "USAJOBS",
    order: 54,
    category: "pipeline",
    requiresCredentials: true,
  },
  ukvisajobs: {
    label: "UK Visa Jobs",
    order: 50,
    category: "pipeline",
    requiresCredentials: true,
    ukOnly: true,
  },
  adzuna: {
    label: "Adzuna",
    order: 60,
    category: "pipeline",
    requiresCredentials: true,
  },
  hiringcafe: { label: "Hiring Cafe", order: 70, category: "pipeline" },
  startupjobs: { label: "startup.jobs", order: 80, category: "pipeline" },
  workingnomads: {
    label: "Working Nomads",
    order: 90,
    category: "pipeline",
  },
  golangjobs: {
    label: "Golang Jobs",
    order: 100,
    category: "pipeline",
  },
  jobindex: {
    label: "Jobindex",
    order: 103,
    category: "pipeline",
  },
  seek: {
    label: "Seek",
    order: 105,
    category: "pipeline",
    requiresCredentials: true,
  },
  naukri: {
    label: "Naukri",
    order: 107,
    category: "pipeline",
  },
  fiveamsat: { label: "Khamsat", order: 109, category: "pipeline" },
  wazzuf: { label: "WUZZUF", order: 110, category: "pipeline" },
  everjobs: { label: "Ever Jobs", order: 115, category: "pipeline" },
  manual: { label: "Manual", order: 120, category: "manual" },
};

export const PIPELINE_EXTRACTOR_SOURCE_IDS = EXTRACTOR_SOURCE_IDS.filter(
  (source) => EXTRACTOR_SOURCE_METADATA[source].category === "pipeline",
);

const extractorSourceTuple = EXTRACTOR_SOURCE_IDS as unknown as [
  ExtractorSourceId,
  ...ExtractorSourceId[],
];

export const extractorSourceEnum = z.enum(extractorSourceTuple);

export function isExtractorSourceId(value: string): value is ExtractorSourceId {
  return EXTRACTOR_SOURCE_IDS.includes(value as ExtractorSourceId);
}

export function sourceLabel(source: ExtractorSourceId): string {
  return EXTRACTOR_SOURCE_METADATA[source].label;
}

export function sortSources<T extends { source: ExtractorSourceId }>(
  values: T[],
): T[] {
  return [...values].sort(
    (left, right) =>
      EXTRACTOR_SOURCE_METADATA[left.source].order -
      EXTRACTOR_SOURCE_METADATA[right.source].order,
  );
}
