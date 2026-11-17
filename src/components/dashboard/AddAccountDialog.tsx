"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  Server,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  api,
  type BrokerSearchResultDTO,
  type CreateAccountResultDTO,
  type SrvDecodeResultDTO,
} from "@/components/dashboard/api";
import type { AccountSummary, OwnerDTO, Platform, ResolvedEndpoint } from "@/lib/types";
import { cn } from "@/lib/utils";

const NEW_OWNER = "__new__";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owners: OwnerDTO[];
  onCreated: (account: AccountSummary) => void;
}

interface FormState {
  ownerMode: "existing" | "new";
  ownerId: string;
  newOwnerName: string;
  platform: Platform;
  brokerName: string;
  serverName: string;
  serverHost: string;
  serverPort: string;
  login: string;
  password: string;
  testConnection: boolean;
}

function initialForm(owners: OwnerDTO[]): FormState {
  return {
    ownerMode: owners.length > 0 ? "existing" : "new",
    ownerId: owners[0]?.id ?? "",
    newOwnerName: "Main",
    platform: "MT5",
    brokerName: "",
    serverName: "",
    serverHost: "",
    serverPort: "",
    login: "",
    password: "",
    testConnection: true,
  };
}

export function AddAccountDialog({ open, onOpenChange, owners, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(() => initialForm(owners));
  const [submitting, setSubmitting] = useState(false);

  // Broker autocomplete
  const [suggestions, setSuggestions] = useState<BrokerSearchResultDTO | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const brokerBoxRef = useRef<HTMLDivElement | null>(null);

  // .srv file decoding
  const [srvBusy, setSrvBusy] = useState(false);
  const [srvResult, setSrvResult] = useState<{ name: string; endpoints: ResolvedEndpoint[] } | null>(null);
  const [srvError, setSrvError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Reset the form when the dialog is closed; align owner selection with the
  // loaded owners list on the very first open.
  useEffect(() => {
    if (open) {
      setForm((f) =>
        f.ownerMode === "new" && f.ownerId === "" && owners.length > 0
          ? { ...f, ownerMode: "existing", ownerId: owners[0].id }
          : f
      );
    } else {
      setForm(initialForm(owners));
      setSuggestions(null);
      setSuggestOpen(false);
      setSrvResult(null);
      setSrvError(null);
    }
  }, [open]);

  // Default the owner select once owners arrive.
  useEffect(() => {
    if (form.ownerMode === "existing" && !form.ownerId && owners.length > 0) {
      set("ownerId", owners[0].id);
    }
  }, [owners, form.ownerMode, form.ownerId]);

  // Debounced broker suggestions.
  useEffect(() => {
    if (!open) return;
    const q = form.brokerName.trim();
    if (q.length < 2) {
      setSuggestions(null);
      setSuggesting(false);
      return;
    }
    setSuggesting(true);
    const t = setTimeout(() => {
      api<BrokerSearchResultDTO>(
        `/api/brokers/search?q=${encodeURIComponent(q)}&platform=${form.platform}`
      )
        .then((res) => {
          setSuggestions(res);
          setSuggestOpen(true);
        })
        .catch(() => setSuggestions(null))
        .finally(() => setSuggesting(false));
    }, 350);
    return () => clearTimeout(t);
  }, [form.brokerName, form.platform, open]);

  // Close the suggestion dropdown when focus leaves the broker field.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (brokerBoxRef.current && !brokerBoxRef.current.contains(e.target as Node)) {
        setSuggestOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const applySuggestion = (name: string, detail?: string) => {
    setForm((f) => ({
      ...f,
      brokerName: name,
      serverName: detail ?? f.serverName,
    }));
    setSuggestOpen(false);
  };

  const handleSrvFile = async (file: File) => {
    setSrvBusy(true);
    setSrvError(null);
    setSrvResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/srv/decode", { method: "POST", body: fd });
      const body = (await res.json()) as SrvDecodeResultDTO;
      if (!res.ok || !body.ok || !body.endpoints) {
        throw new Error(body.error ?? "Could not decode the .srv file");
      }
      setSrvResult({ name: body.name ?? "", endpoints: body.endpoints });
    } catch (err) {
      setSrvError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setSrvBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const canSubmit =
    !submitting &&
    form.brokerName.trim().length > 0 &&
    form.login.trim().length > 0 &&
    form.password.length > 0 &&
    (form.ownerMode === "new" || form.ownerId !== "");

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        platform: form.platform,
        brokerName: form.brokerName.trim(),
        login: form.login.trim(),
        password: form.password,
        testConnection: form.testConnection,
      };
      if (form.ownerMode === "new") {
        body.ownerName = form.newOwnerName.trim() || "Main";
      } else {
        body.ownerId = form.ownerId;
      }
      if (form.serverName.trim()) body.serverName = form.serverName.trim();
      if (form.serverHost.trim()) body.serverHost = form.serverHost.trim();
      const port = Number.parseInt(form.serverPort, 10);
      if (Number.isFinite(port)) body.serverPort = port;

      const res = await api<CreateAccountResultDTO>("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast.success("Account added", {
        description:
          res.resolution.note ??
          `Server resolved via ${res.resolution.source} (${res.resolution.endpoints.length} endpoint${res.resolution.endpoints.length === 1 ? "" : "s"}).`,
      });
      onOpenChange(false);
      onCreated(res.account);
    } catch (err) {
      toast.error("Could not add account", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ts-scroll max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="tracking-tight">Add account</DialogTitle>
          <DialogDescription>
            Connect a MetaTrader account for read-only monitoring. Use the
            investor (read-only) password.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="add-platform">Platform</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={form.platform}
                onValueChange={(v) => {
                  if (v === "MT4" || v === "MT5") set("platform", v);
                }}
                className="w-full"
                aria-label="Platform"
              >
                <ToggleGroupItem value="MT5" className="flex-1">
                  MT5
                </ToggleGroupItem>
                <ToggleGroupItem value="MT4" className="flex-1">
                  MT4
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="add-owner">Owner</Label>
              <Select
                value={form.ownerMode === "new" ? NEW_OWNER : form.ownerId}
                onValueChange={(v) => {
                  if (v === NEW_OWNER) set("ownerMode", "new");
                  else {
                    set("ownerMode", "existing");
                    set("ownerId", v);
                  }
                }}
              >
                <SelectTrigger id="add-owner" className="w-full">
                  <SelectValue placeholder="Select owner" />
                </SelectTrigger>
                <SelectContent>
                  {owners.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_OWNER}>+ New owner</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.ownerMode === "new" && (
            <div className="grid gap-2">
              <Label htmlFor="add-owner-name">New owner name</Label>
              <Input
                id="add-owner-name"
                value={form.newOwnerName}
                onChange={(e) => set("newOwnerName", e.target.value)}
                placeholder="Main"
              />
            </div>
          )}

          <div className="grid gap-2" ref={brokerBoxRef}>
            <Label htmlFor="add-broker">Broker name</Label>
            <div className="relative">
              <Input
                id="add-broker"
                value={form.brokerName}
                onChange={(e) => {
                  set("brokerName", e.target.value);
                  setSuggestOpen(true);
                }}
                onFocus={() => {
                  if (suggestions) setSuggestOpen(true);
                }}
                placeholder="e.g. ICMarkets"
                autoComplete="off"
                aria-autocomplete="list"
              />
              {suggesting && (
                <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-zinc-500" />
              )}
              {suggestOpen && suggestions && suggestions.items.length > 0 && (
                <ul
                  role="listbox"
                  aria-label="Broker suggestions"
                  className="absolute z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl ts-scroll"
                >
                  {suggestions.items.map((item) => (
                    <li key={`${item.platform}-${item.name}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => applySuggestion(item.name, item.detail)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                      >
                        <span className="truncate">{item.name}</span>
                        {item.detail && (
                          <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                            {item.detail}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {suggestions && !suggestions.reachable && (
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/70">
                <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                {suggestions.note ?? "Broker index unreachable - enter the server manually."}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="add-server">Server label (optional)</Label>
            <Input
              id="add-server"
              value={form.serverName}
              onChange={(e) => set("serverName", e.target.value)}
              placeholder="e.g. ICMarketsSC-MT5"
            />
          </div>

          <Collapsible>
            <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
              <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
              Advanced server settings
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 grid gap-3 overflow-hidden">
              <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                <div className="grid gap-1.5">
                  <Label htmlFor="add-host">Server host</Label>
                  <Input
                    id="add-host"
                    value={form.serverHost}
                    onChange={(e) => set("serverHost", e.target.value)}
                    placeholder="e.g. icmarkets.ctrader.com"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="add-port">Server port</Label>
                  <Input
                    id="add-port"
                    type="number"
                    inputMode="numeric"
                    value={form.serverPort}
                    onChange={(e) => set("serverPort", e.target.value)}
                    placeholder="443"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="add-srv">Server certificate (.srv file)</Label>
                <input
                  ref={fileRef}
                  id="add-srv"
                  type="file"
                  accept=".srv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleSrvFile(f);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => fileRef.current?.click()}
                  disabled={srvBusy}
                >
                  {srvBusy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Upload className="size-3.5" />
                  )}
                  Upload .srv file
                </Button>
                {srvResult && (
                  <div className="rounded-md border border-emerald-400/20 bg-emerald-400/[0.05] p-2.5 text-xs">
                    <p className="flex items-center gap-1.5 font-medium text-emerald-300">
                      <Server className="size-3.5" aria-hidden />
                      Decoded: {srvResult.name || "unknown broker"}
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {srvResult.endpoints.map((ep) => (
                        <li
                          key={`${ep.host}:${ep.port}`}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="truncate font-mono text-[11px] text-zinc-400">
                            {ep.host}:{ep.port}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => {
                              set("serverHost", ep.host);
                              set("serverPort", String(ep.port));
                            }}
                          >
                            Use
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {srvError && (
                  <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-300">
                    <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
                    {srvError}
                  </p>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="add-login">Login</Label>
              <Input
                id="add-login"
                value={form.login}
                onChange={(e) => set("login", e.target.value)}
                placeholder="e.g. 51823041"
                className="font-mono"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="add-password">Investor password</Label>
              <Input
                id="add-password"
                type="password"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder="Read-only password"
                autoComplete="new-password"
              />
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Use the read-only INVESTOR password - never your master/trade
                password.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
            <div>
              <Label htmlFor="add-test" className="text-xs">
                Test connection on save
              </Label>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                Verifies the server endpoints before storing credentials.
              </p>
            </div>
            <Switch
              id="add-test"
              checked={form.testConnection}
              onCheckedChange={(v) => set("testConnection", v)}
            />
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] p-2.5">
            <ShieldCheck
              className="mt-0.5 size-4 shrink-0 text-emerald-400"
              aria-hidden
            />
            <p className="text-[11px] leading-relaxed text-emerald-200/80">
              Credentials are encrypted with AES-256-GCM before storage. The app
              only ever reads market/account data - trades are impossible.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <Check className="size-4" />
                Add account
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
