import { z } from "zod";

export const EXTRACTOR_SOURCE_IDS = [
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
  "workingnomads",
  "hiringcafe",
  "startupjobs",
  "gradcracker",
  "indeed",
  "linkedin",
  "glassdoor",
  "ukvisajobs",
  "adzuna",
  "golangjobs",
  "jobindex",
  "seek",
  "naukri",
  "everjobs",
  "fiveamsat",
  "wazzuf",
  "freehire",
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
  remotive: { label: "Remotive", order: 10, category: "pipeline" },
  jobicy: { label: "Jobicy", order: 20, category: "pipeline" },
  weworkremotely: {
    label: "We Work Remotely",
    order: 30,
    category: "pipeline",
  },
  themuse: { label: "The Muse", order: 40, category: "pipeline" },
  arbeitnow: { label: "Arbeitnow", order: 50, category: "pipeline" },
  remoteok: { label: "Remote OK", order: 55, category: "pipeline" },
  greenhouse: { label: "Greenhouse", order: 56, category: "pipeline" },
  lever: { label: "Lever", order: 57, category: "pipeline" },
  ashby: { label: "Ashby", order: 58, category: "pipeline" },
  smartrecruiters: {
    label: "SmartRecruiters",
    order: 59,
    category: "pipeline",
  },
  telegram: { label: "Telegram", order: 60, category: "pipeline" },
  himalayas: { label: "Himalayas", order: 61, category: "pipeline" },
  hnhiring: {
    label: "HN Who is Hiring",
    order: 62,
    category: "pipeline",
  },
  usajobs: {
    label: "USAJOBS",
    order: 63,
    category: "pipeline",
    requiresCredentials: true,
  },
  workingnomads: {
    label: "Working Nomads",
    order: 65,
    category: "pipeline",
  },
  hiringcafe: { label: "Hiring Cafe", order: 70, category: "pipeline" },
  startupjobs: { label: "startup.jobs", order: 80, category: "pipeline" },
  gradcracker: {
    label: "Gradcracker",
    order: 90,
    category: "pipeline",
    ukOnly: true,
  },
  indeed: { label: "Indeed", order: 100, category: "pipeline" },
  linkedin: { label: "LinkedIn", order: 110, category: "pipeline" },
  glassdoor: { label: "Glassdoor", order: 120, category: "pipeline" },
  ukvisajobs: {
    label: "UK Visa Jobs",
    order: 130,
    category: "pipeline",
    requiresCredentials: true,
    ukOnly: true,
  },
  adzuna: {
    label: "Adzuna",
    order: 140,
    category: "pipeline",
    requiresCredentials: true,
  },
  golangjobs: {
    label: "Golang Jobs",
    order: 150,
    category: "pipeline",
  },
  jobindex: {
    label: "Jobindex",
    order: 160,
    category: "pipeline",
  },
  seek: {
    label: "Seek",
    order: 170,
    category: "pipeline",
    requiresCredentials: true,
  },
  naukri: {
    label: "Naukri",
    order: 180,
    category: "pipeline",
  },
  everjobs: { label: "Ever Jobs", order: 185, category: "pipeline" },
  fiveamsat: { label: "Khamsat", order: 109, category: "pipeline" },
  wazzuf: { label: "WUZZUF", order: 110, category: "pipeline" },
  freehire: { label: "FreeHire", order: 115, category: "pipeline" },
  manual: { label: "Manual", order: 190, category: "manual" },
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
