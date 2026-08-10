import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Briefcase,
  DollarSign,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  type FreelanceGigItem,
  getFreelanceGigs,
  getFreelancePlatforms,
  getFreelanceProposals,
  getFreelanceStats,
  proposeFreelanceGig,
  runFreelanceCycle,
} from "@/client/api/freelance";
import { useQueryErrorToast } from "@/client/hooks/useQueryErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const DEFAULT_SKILLS = [
  "TypeScript",
  "React",
  "Node.js",
  "PostgreSQL",
  "Python",
  "AWS",
];

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <Badge variant="outline">—</Badge>;
  const variant =
    score >= 70 ? "default" : score >= 50 ? "secondary" : "outline";
  return <Badge variant={variant}>{score}</Badge>;
}

export function FreelancePage() {
  const queryClient = useQueryClient();
  const [minScore, setMinScore] = useState(50);

  const statsQuery = useQuery({
    queryKey: ["freelance", "stats"],
    queryFn: getFreelanceStats,
  });
  const platformsQuery = useQuery({
    queryKey: ["freelance", "platforms"],
    queryFn: getFreelancePlatforms,
  });
  const gigsQuery = useQuery({
    queryKey: ["freelance", "gigs", minScore],
    queryFn: () => getFreelanceGigs({ minScore, limit: 50 }),
  });
  const proposalsQuery = useQuery({
    queryKey: ["freelance", "proposals"],
    queryFn: getFreelanceProposals,
  });

  useQueryErrorToast(statsQuery.error, "Failed to load freelance stats");
  useQueryErrorToast(gigsQuery.error, "Failed to load gigs");

  const runMutation = useMutation({
    mutationFn: () =>
      runFreelanceCycle({
        searchTerms: ["typescript", "react", "node", "python", "engineer"],
        profileSkills: DEFAULT_SKILLS,
        minScore,
      }),
    onSuccess: (data) => {
      toast.success(
        `Discovered ${data.discovered} gigs, ${data.enqueued} above threshold (${data.persisted.created} new)`,
      );
      queryClient.invalidateQueries({ queryKey: ["freelance"] });
    },
    onError: () => toast.error("Aggregation cycle failed"),
  });

  const proposeMutation = useMutation({
    mutationFn: (gig: FreelanceGigItem) =>
      proposeFreelanceGig(gig.id, DEFAULT_SKILLS),
    onSuccess: (data) => {
      toast.success(
        data.mode === "dry_run"
          ? "Proposal drafted (dry-run — enable apply to submit)"
          : "Proposal drafted",
      );
      queryClient.invalidateQueries({ queryKey: ["freelance"] });
    },
    onError: () => toast.error("Proposal generation failed"),
  });

  const stats = statsQuery.data;
  const gigs = gigsQuery.data?.gigs ?? [];
  const proposals = proposalsQuery.data?.proposals ?? [];
  const platforms = platformsQuery.data?.platforms ?? [];

  const totalGigs = Object.values(stats?.gigsByStatus ?? {}).reduce(
    (a, b) => a + b,
    0,
  );
  const readyCount =
    (stats?.gigsByStatus?.scored ?? 0) + (stats?.gigsByStatus?.ready ?? 0);

  return (
    <div className="container mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-bold text-3xl">
            <Briefcase className="h-8 w-8" /> Freelance Aggregator
          </h1>
          <p className="text-muted-foreground">
            Discover, dedupe, score and propose across 18 platforms.
          </p>
        </div>
        <Button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          size="lg"
        >
          {runMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          Run Discovery
        </Button>
      </div>

      {/* Safety banner */}
      <Card className="border-amber-500/50 bg-amber-500/5">
        <CardContent className="flex items-center gap-3 p-4">
          <ShieldCheck className="h-6 w-6 shrink-0 text-amber-600" />
          <div className="text-sm">
            <span className="font-semibold">
              {stats?.autobidEnabled ? "Auto-bid enabled" : "Dry-run mode"}
            </span>{" "}
            — proposals are generated but{" "}
            {stats?.autobidEnabled ? "will be submitted" : "not submitted"}{" "}
            unless the platform gate is open. See{" "}
            <code className="rounded bg-muted px-1">.env.example</code> for the
            money path.
          </div>
        </CardContent>
      </Card>

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="font-medium text-sm">Total gigs</CardTitle>
            <Briefcase className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">{totalGigs}</div>
            <p className="text-muted-foreground text-xs">
              {readyCount} ready to bid
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="font-medium text-sm">Proposals</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">{proposals.length}</div>
            <p className="text-muted-foreground text-xs">
              {Object.values(stats?.proposalsByStatus ?? {}).reduce(
                (a, b) => a + b,
                0,
              )}{" "}
              total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="font-medium text-sm">Earned (paid)</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              ${(stats?.earnings.totalPaid ?? 0).toFixed(2)}
            </div>
            <p className="text-muted-foreground text-xs">
              ${(stats?.earnings.totalPending ?? 0).toFixed(2)} pending
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="font-medium text-sm">Platforms</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {platforms.filter((p) => p.available).length}
            </div>
            <p className="text-muted-foreground text-xs">
              of {platforms.length} registered
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Gig feed */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Top-matched gigs</CardTitle>
                <CardDescription>
                  Scored against your profile skills
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  Min score: {minScore}
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="w-24"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => gigsQuery.refetch()}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {gigsQuery.isLoading ? (
              <div className="flex justify-center p-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : gigs.length === 0 ? (
              <p className="p-8 text-center text-muted-foreground">
                No gigs yet — run discovery to pull live listings.
              </p>
            ) : (
              gigs.map((gig) => (
                <div
                  key={gig.id}
                  className="flex items-start justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <ScoreBadge score={gig.suitabilityScore} />
                      <Badge variant="outline">{gig.platform}</Badge>
                      <span className="truncate font-medium">{gig.title}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground text-xs">
                      {gig.clientOrEmployer}
                      {gig.budget ? ` • ${gig.budget}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={proposeMutation.isPending}
                      onClick={() => proposeMutation.mutate(gig)}
                    >
                      <FileText className="mr-1 h-3 w-3" />
                      Propose
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a
                        href={gig.gigUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open
                      </a>
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Side column: platforms + proposals */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Platforms</CardTitle>
              <CardDescription>Registry & config status</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {platforms.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{p.displayName}</span>
                  <div className="flex gap-1">
                    <Badge variant={p.available ? "default" : "outline"}>
                      {p.available ? "live" : "no-creds"}
                    </Badge>
                    {p.applyEnabled && <Badge variant="secondary">apply</Badge>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent proposals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {proposals.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No proposals drafted yet.
                </p>
              ) : (
                proposals.slice(0, 8).map((proposal) => (
                  <div key={proposal.id} className="rounded border p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">{proposal.platform}</Badge>
                      <Badge
                        variant={
                          proposal.mode === "dry_run" ? "secondary" : "default"
                        }
                      >
                        {proposal.mode}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-muted-foreground">
                      {proposal.coverLetter}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Earnings by platform */}
      {stats && Object.keys(stats.earnings.byPlatform).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Earnings by platform</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(stats.earnings.byPlatform).map(
              ([platform, amount]) => {
                const max = Math.max(
                  ...Object.values(stats.earnings.byPlatform),
                  1,
                );
                return (
                  <div key={platform} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="capitalize">{platform}</span>
                      <span className="font-medium">${amount.toFixed(2)}</span>
                    </div>
                    <Progress value={(amount / max) * 100} />
                  </div>
                );
              },
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
