"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Info,
  Loader2,
  Radio,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/components/dashboard/api";
import type { AgentConfigDTO } from "@/lib/types";

/** Read-only field with a copy button (agent inputs, commands). */
function CopyField({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard can be blocked - fall back to a hidden textarea selection
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [value]);

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="flex items-stretch gap-2">
        <pre
          aria-label={label}
          className={`ts-scroll min-w-0 flex-1 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 font-mono text-xs text-zinc-200 ${
            multiline ? "whitespace-pre-wrap break-all" : "whitespace-nowrap"
          }`}
        >
          {value}
        </pre>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          className="shrink-0 self-stretch"
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-400" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[11px] font-semibold text-emerald-300">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        <div className="space-y-2 text-[13px] leading-relaxed text-zinc-400">
          {children}
        </div>
      </div>
    </li>
  );
}

const REPO_BASE = "https://github.com/iain504/tradebuddy/blob/main/agents";

export function AgentSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [config, setConfig] = useState<AgentConfigDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refetch on every open. Previously loaded config stays visible until the
  // fresh response arrives (avoids cascading renders from sync setState).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<AgentConfigDTO>("/api/agent/config")
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const ingestUrl = config?.ingestUrl ?? "<your-tradebuddy-url>/api/ingest";
  const token = config?.token ?? "<INGEST_TOKEN from your .env>";
  const tokenHidden = Boolean(config && !config.token && config.tokenRequired);

  const mt4Inputs = useMemo(
    () => `IngestURL   = ${ingestUrl}\nIngestToken = ${token}\nPollSeconds = 30`,
    [ingestUrl, token]
  );
  const mt5Inputs = useMemo(
    () => `IngestURL   = ${ingestUrl}\nIngestToken = ${token}\nPollSeconds = 30`,
    [ingestUrl, token]
  );
  const pyCommand = useMemo(
    () =>
      `pip install MetaTrader5 requests\npython mt5_agent.py --url "${ingestUrl}" --token "${token}" --poll 30`,
    [ingestUrl, token]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto ts-scroll sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="size-4 text-emerald-400" />
            Connect MT4 / MT5 with push agents
          </DialogTitle>
          <DialogDescription>
            Agents run where your terminals already run (Windows VPS, desktop,
            or Wine) and push snapshots straight into this dashboard. No Wine
            containers, no MetaQuotes installer - the most reliable data path.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            Could not load agent config: {error}
          </div>
        )}
        {!config && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" /> Loading agent
            configuration...
          </div>
        )}

        {config && (
          <Tabs defaultValue="mt4" className="gap-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="mt4">MT4 terminal</TabsTrigger>
              <TabsTrigger value="mt5">MT5 terminal</TabsTrigger>
            </TabsList>

            {/* ------------------------------------------------------------ MT4 */}
            <TabsContent value="mt4" className="space-y-4">
              <ol className="space-y-4">
                <Step n={1} title="Get the EA into your MT4 terminal">
                  <p>
                    Download{" "}
                    <a
                      className="inline-flex items-center gap-1 font-medium text-emerald-300 underline-offset-2 hover:underline"
                      href={`${REPO_BASE}/mt4-agent/TradeBuddyAgent.mq4`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      TradeBuddyAgent.mq4 <ExternalLink className="size-3" />
                    </a>{" "}
                    and copy it into the terminal&apos;s{" "}
                    <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px]">
                      MQL4/Experts
                    </code>{" "}
                    folder (MT4 menu: <em>File → Open Data Folder</em>), then
                    compile it in MetaEditor (F7).
                  </p>
                </Step>
                <Step n={2} title="Allow the WebRequest URL in MT4">
                  <p>
                    Tools → Options → Expert Advisors → tick{" "}
                    <em>&ldquo;Allow WebRequest for listed URL&rdquo;</em> and
                    add the base URL of this dashboard:
                  </p>
                  <CopyField
                    label="URL to whitelist"
                    value={ingestUrl.replace(/\/api\/ingest$/, "")}
                  />
                </Step>
                <Step n={3} title="Add the account in this dashboard">
                  <p>
                    Use <em>Add account</em> with the same login + broker server
                    as in the terminal (investor password). The EA is matched to
                    it automatically by login.
                  </p>
                </Step>
                <Step n={4} title="Attach the EA to any chart">
                  <p>
                    Drag <em>TradeBuddyAgent</em> onto a chart and fill the
                    inputs (no autotrading needed, read-only):
                  </p>
                  <CopyField label="EA inputs" value={mt4Inputs} multiline />
                </Step>
                <Step n={5} title="Let MT4 see your full history">
                  <p>
                    In the terminal&apos;s <em>Account History</em> tab
                    (bottom), right-click → <em>All History</em>, so the agent
                    can backfill every closed trade once.
                  </p>
                </Step>
              </ol>
              <p className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200/80">
                <Check className="mt-0.5 size-3.5 shrink-0" />
                A green smiley on the chart + &ldquo;pushed&rdquo; entries in
                the Experts tab mean data is flowing. First push backfills all
                closed trades, then live data arrives every PollSeconds.
              </p>
            </TabsContent>

            {/* ------------------------------------------------------------ MT5 */}
            <TabsContent value="mt5" className="space-y-4">
              <ol className="space-y-4">
                <Step n={1} title="Get the EA into your MT5 terminal">
                  <p>
                    Download{" "}
                    <a
                      className="inline-flex items-center gap-1 font-medium text-emerald-300 underline-offset-2 hover:underline"
                      href={`${REPO_BASE}/mt5-agent/TradeBuddyAgent.mq5`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      TradeBuddyAgent.mq5 <ExternalLink className="size-3" />
                    </a>{" "}
                    into{" "}
                    <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px]">
                      MQL5/Experts
                    </code>{" "}
                    (MT5 menu: <em>File → Open Data Folder</em>), compile with
                    F7, then attach to any chart with these inputs:
                  </p>
                  <CopyField label="EA inputs" value={mt5Inputs} multiline />
                </Step>
                <Step n={2} title="Allow the WebRequest URL in MT5">
                  <p>
                    Tools → Options → Expert Advisors → tick{" "}
                    <em>&ldquo;Allow WebRequest for listed URL&rdquo;</em> and
                    add:
                  </p>
                  <CopyField
                    label="URL to whitelist"
                    value={ingestUrl.replace(/\/api\/ingest$/, "")}
                  />
                </Step>
              </ol>
              <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-zinc-200">
                  <TerminalSquare className="size-4 text-zinc-400" />
                  Alternative: Python agent (Windows, no EA)
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">
                  Uses the official MetaTrader5 package. Log the terminal in,
                  then run:
                </p>
                <div className="mt-2">
                  <CopyField label="Commands" value={pyCommand} multiline />
                </div>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
                  <Download className="size-3" />
                  Script:{" "}
                  <a
                    className="text-emerald-300 underline-offset-2 hover:underline"
                    href={`${REPO_BASE}/mt5-agent/mt5_agent.py`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    agents/mt5-agent/mt5_agent.py
                  </a>
                </p>
              </div>
              <p className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200/80">
                <Check className="mt-0.5 size-3.5 shrink-0" />
                MT5 tip: the EA/agent reads the full deal history on first push -
                no manual history export needed.
              </p>
            </TabsContent>
          </Tabs>
        )}

        {tokenHidden && (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            The ingest token is hidden on this instance. Set{" "}
            <code className="mx-1 rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px]">
              EXPOSE_INGEST_TOKEN=1
            </code>{" "}
            (private/self-hosted setups) to get copy-paste ready values, or copy
            the token manually from your <em>.env</em> file.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
