"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountDetail } from "@/components/dashboard/AccountDetail";
import {
  AccountsRail,
  ALL_ACCOUNTS,
} from "@/components/dashboard/AccountsRail";
import { AddAccountDialog } from "@/components/dashboard/AddAccountDialog";
import {
  api,
  type HealthDTO,
  type ReportRange,
  type SyncResultDTO,
} from "@/components/dashboard/api";
import { AggregateView } from "@/components/dashboard/AggregateView";
import { DemoBanner } from "@/components/dashboard/DemoBanner";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Footer } from "@/components/dashboard/Footer";
import { Header } from "@/components/dashboard/Header";
import { DetailSkeleton, RailSkeleton } from "@/components/dashboard/Skeletons";
import { FadeIn, Panel } from "@/components/dashboard/ui-bits";
import type { AccountSummary, OwnerDTO, ReportDTO } from "@/lib/types";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

export default function HomePage() {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const [selected, setSelected] = useState<string>(ALL_ACCOUNTS);
  const [range, setRange] = useState<ReportRange>("3M");
  const [report, setReport] = useState<ReportDTO | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [aggReports, setAggReports] = useState<Array<ReportDTO | null> | null>(null);
  const [aggLoading, setAggLoading] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /** Cache of fetched reports; cleared whenever data may have changed. */
  const cacheRef = useRef(new Map<string, ReportDTO>());
  const [tick, setTick] = useState(0);
  const invalidate = useCallback(() => {
    cacheRef.current.clear();
    setTick((t) => t + 1);
  }, []);

  // Dark tokens for Radix portals rendered outside the themed wrapper.
  useEffect(() => {
    document.documentElement.classList.add("dark");
    return () => document.documentElement.classList.remove("dark");
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      const [acc, h] = await Promise.all([
        api<{ accounts: AccountSummary[] }>("/api/accounts"),
        api<HealthDTO>("/api/health").catch(() => null),
      ]);
      setAccounts(acc.accounts);
      if (h) setHealth(h);
    } catch (err) {
      toast.error("Failed to load accounts", { description: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void refreshAccounts().finally(() => setAccountsLoading(false));
  }, [refreshAccounts]);

  // Aggregate (All accounts) reports, fetched in parallel.
  useEffect(() => {
    if (!accounts || accounts.length === 0 || selected !== ALL_ACCOUNTS) return;
    let cancelled = false;
    setAggLoading(true);
    Promise.all(
      accounts.map(async (a): Promise<ReportDTO | null> => {
        const key = `${a.id}:ALL`;
        const hit = cacheRef.current.get(key);
        if (hit) return hit;
        try {
          const r = await api<ReportDTO>(`/api/accounts/${a.id}/report?range=ALL`);
          cacheRef.current.set(key, r);
          return r;
        } catch {
          return null;
        }
      })
    )
      .then((rs) => {
        if (!cancelled) setAggReports(rs);
      })
      .finally(() => {
        if (!cancelled) setAggLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accounts, selected, tick]);

  // Selected account report.
  useEffect(() => {
    if (selected === ALL_ACCOUNTS || !accounts) return;
    let cancelled = false;
    const key = `${selected}:${range}`;
    const hit = cacheRef.current.get(key);
    if (hit) {
      setReport(hit);
      setReportLoading(false);
      return;
    }
    setReportLoading(true);
    api<ReportDTO>(`/api/accounts/${selected}/report?range=${range}`)
      .then((r) => {
        cacheRef.current.set(key, r);
        if (!cancelled) setReport(r);
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error("Failed to load report", { description: errorMessage(err) });
          setReport(null);
        }
      })
      .finally(() => {
        if (!cancelled) setReportLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accounts, selected, range, tick]);

  const owners = useMemo<OwnerDTO[]>(() => {
    const map = new Map<string, OwnerDTO>();
    accounts?.forEach((a) => map.set(a.owner.id, a.owner));
    return [...map.values()];
  }, [accounts]);

  const lastDataAt = useMemo<string | null>(() => {
    if (!accounts || accounts.length === 0) return null;
    let max: number | null = null;
    for (const a of accounts) {
      const iso = a.latest?.ts ?? a.lastSyncAt;
      if (!iso) continue;
      const n = Date.parse(iso);
      if (!Number.isNaN(n) && (max === null || n > max)) max = n;
    }
    return max === null ? null : new Date(max).toISOString();
  }, [accounts]);

  const activeReport =
    report && report.account.id === selected ? report : null;

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      invalidate();
      await refreshAccounts();
    } finally {
      setRefreshing(false);
    }
  }, [invalidate, refreshAccounts]);

  const handleSync = useCallback(
    async (id: string) => {
      setSyncingId(id);
      try {
        const res = await api<SyncResultDTO>(`/api/accounts/${id}/sync`, {
          method: "POST",
        });
        if (res.mode === "queued") {
          toast.info("Sync queued", {
            description:
              res.message ?? "The collector will fetch fresh data shortly.",
          });
        } else {
          toast.success(
            res.mode === "demo" ? "Demo data refreshed" : "Account synced",
            { description: res.message }
          );
        }
        invalidate();
        await refreshAccounts();
      } catch (err) {
        toast.error("Sync failed", { description: errorMessage(err) });
      } finally {
        setSyncingId(null);
      }
    },
    [invalidate, refreshAccounts]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        await api<{ ok: boolean }>(`/api/accounts/${id}`, { method: "DELETE" });
        toast.success("Account deleted");
        setSelected((cur) => (cur === id ? ALL_ACCOUNTS : cur));
        invalidate();
        await refreshAccounts();
      } catch (err) {
        toast.error("Delete failed", { description: errorMessage(err) });
      } finally {
        setDeletingId(null);
      }
    },
    [invalidate, refreshAccounts]
  );

  const handleSeed = useCallback(async () => {
    setSeeding(true);
    try {
      await api<{ ok: boolean }>("/api/demo/seed", { method: "POST" });
      invalidate();
      await refreshAccounts();
      toast.success("Demo accounts loaded");
    } catch (err) {
      toast.error("Could not load demo accounts", {
        description: errorMessage(err),
      });
    } finally {
      setSeeding(false);
    }
  }, [invalidate, refreshAccounts]);

  const handleCreated = useCallback(
    async (account: AccountSummary) => {
      invalidate();
      await refreshAccounts();
      setSelected(account.id);
    },
    [invalidate, refreshAccounts]
  );

  return (
    <div className="dark flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <style
        dangerouslySetInnerHTML={{
          __html: `.ts-scroll{scrollbar-width:thin;scrollbar-color:#3f3f46 transparent;}.ts-scroll::-webkit-scrollbar{width:6px;height:6px;}.ts-scroll::-webkit-scrollbar-track{background:transparent;}.ts-scroll::-webkit-scrollbar-thumb{background:#3f3f46;border-radius:9999px;}.ts-scroll::-webkit-scrollbar-thumb:hover{background:#52525b;}`,
        }}
      />
      <Toaster
        richColors
        position="bottom-right"
        theme="dark"
        closeButton
      />
      <Header
        onAddAccount={() => setAddOpen(true)}
        onRefresh={() => void handleRefresh()}
        refreshing={refreshing}
      />
      {(() => {
        // Banner only when the pipeline is degraded: collector not configured,
        // or configured but not answering.
        if (!health || bannerDismissed) return null;
        if (!health.collectorConfigured) {
          return (
            <DemoBanner
              variant="not-configured"
              onDismiss={() => setBannerDismissed(true)}
            />
          );
        }
        if (!health.collector) {
          return (
            <DemoBanner
              variant="unreachable"
              onDismiss={() => setBannerDismissed(true)}
            />
          );
        }
        return null;
      })()}

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-5 sm:px-6 sm:py-6">
        {accountsLoading ? (
          <div className="grid gap-4 lg:grid-cols-[330px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <RailSkeleton />
            <DetailSkeleton />
          </div>
        ) : !accounts || accounts.length === 0 ? (
          <EmptyState
            onSeed={() => void handleSeed()}
            onAdd={() => setAddOpen(true)}
            seeding={seeding}
          />
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[330px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <div className="ts-scroll min-w-0 lg:sticky lg:top-[72px] lg:max-h-[calc(100vh-92px)] lg:self-start lg:overflow-y-auto lg:pr-1">
              <FadeIn>
                <AccountsRail
                  accounts={accounts}
                  selected={selected}
                  onSelect={setSelected}
                  onDelete={(id) => void handleDelete(id)}
                  deletingId={deletingId}
                />
              </FadeIn>
            </div>

            <section aria-label="Performance view" className="min-w-0">
              {selected === ALL_ACCOUNTS ? (
                <FadeIn key="aggregate">
                  <AggregateView
                    accounts={accounts}
                    reports={aggReports}
                    loading={aggLoading}
                  />
                </FadeIn>
              ) : activeReport ? (
                <FadeIn key={selected}>
                  <AccountDetail
                    report={activeReport}
                    range={range}
                    onRangeChange={setRange}
                    onSync={() => void handleSync(selected)}
                    syncing={syncingId === selected}
                  />
                </FadeIn>
              ) : reportLoading ? (
                <DetailSkeleton />
              ) : (
                <Panel className="flex flex-col items-center gap-3 p-10 text-center">
                  <p className="text-sm text-zinc-400">
                    Could not load the report for this account.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRefresh()}
                  >
                    <RefreshCw className="size-3.5" />
                    Retry
                  </Button>
                </Panel>
              )}
            </section>
          </div>
        )}
      </main>

      <Footer health={health} lastDataAt={lastDataAt} />

      <AddAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        owners={owners}
        onCreated={(a) => void handleCreated(a)}
      />
    </div>
  );
}
