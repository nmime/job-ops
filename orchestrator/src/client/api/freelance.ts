import { fetchApi } from "./core";

export interface FreelancePlatformStatus {
  id: string;
  displayName: string;
  kind: string;
  available: boolean;
  applyEnabled: boolean;
}

export interface FreelancePlatformsResponse {
  platforms: FreelancePlatformStatus[];
  autobidEnabled: boolean;
  enabledPlatforms: string[];
}

export interface FreelanceGigItem {
  id: string;
  platform: string;
  title: string;
  clientOrEmployer: string;
  gigUrl: string;
  budget?: string | null;
  status: string;
  suitabilityScore: number | null;
  updatedAt: string;
}

export interface FreelanceGigsResponse {
  gigs: FreelanceGigItem[];
  count: number;
}

export interface FreelanceRunResponse {
  discovered: number;
  deduped: number;
  scored: number;
  enqueued: number;
  persisted: { created: number; updated: number };
  perPlatform: Array<{
    platform: string;
    success: boolean;
    found: number;
    error?: string;
  }>;
}

export interface FreelanceStatsResponse {
  gigsByStatus: Record<string, number>;
  proposalsByStatus: Record<string, number>;
  earnings: {
    totalPaid: number;
    totalPending: number;
    byPlatform: Record<string, number>;
  };
  autobidEnabled: boolean;
}

export interface FreelanceProposalItem {
  id: string;
  gigId: string;
  platform: string;
  coverLetter: string;
  mode: string;
  status: string;
  generatedAt: string;
}

export interface FreelanceProposalsResponse {
  proposals: FreelanceProposalItem[];
  count: number;
}

export interface FreelanceProposeResponse {
  proposal: FreelanceProposalItem;
  mode: string;
  applyEnabled: boolean;
}

export async function getFreelancePlatforms(): Promise<FreelancePlatformsResponse> {
  return fetchApi<FreelancePlatformsResponse>("/freelance/platforms");
}

export async function getFreelanceGigs(params?: {
  minScore?: number;
  limit?: number;
}): Promise<FreelanceGigsResponse> {
  const query = new URLSearchParams();
  if (params?.minScore != null) query.set("minScore", String(params.minScore));
  if (params?.limit != null) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return fetchApi<FreelanceGigsResponse>(`/freelance/gigs${suffix}`);
}

export async function runFreelanceCycle(input: {
  searchTerms?: string[];
  profileSkills?: string[];
  minScore?: number;
}): Promise<FreelanceRunResponse> {
  return fetchApi<FreelanceRunResponse>("/freelance/run", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getFreelanceStats(): Promise<FreelanceStatsResponse> {
  return fetchApi<FreelanceStatsResponse>("/freelance/stats");
}

export async function getFreelanceProposals(): Promise<FreelanceProposalsResponse> {
  return fetchApi<FreelanceProposalsResponse>("/freelance/proposals?limit=50");
}

export async function proposeFreelanceGig(
  gigId: string,
  profileSkills: string[],
): Promise<FreelanceProposeResponse> {
  return fetchApi<FreelanceProposeResponse>(
    `/freelance/gigs/${encodeURIComponent(gigId)}/propose`,
    { method: "POST", body: JSON.stringify({ profileSkills }) },
  );
}

export interface FreelanceEarningItem {
  id: string;
  gigId: string | null;
  platform: string;
  amount: number;
  currency: string;
  status: "pending" | "invoiced" | "paid" | "cancelled";
  paidAt: string | null;
  recordedAt: string;
}

export interface FreelanceRecordEarningInput {
  gigId?: string;
  platform: string;
  amount: number;
  currency?: string;
  status?: "pending" | "invoiced" | "paid" | "cancelled";
}

export async function recordFreelanceEarning(
  input: FreelanceRecordEarningInput,
): Promise<{ earning: FreelanceEarningItem }> {
  return fetchApi<{ earning: FreelanceEarningItem }>("/freelance/earnings", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
