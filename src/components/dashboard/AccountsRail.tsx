"use client";

import { useMemo } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DemoChip,
  PlatformBadge,
  StatusDot,
  pnlClass,
} from "@/components/dashboard/ui-bits";
import type { AccountSummary } from "@/lib/types";
import { fmtMoney, fmtSigned, relTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Loader2, Trash2, Wallet } from "lucide-react";

export const ALL_ACCOUNTS = "__all__";

const cardShell =
  "rounded-xl border bg-zinc-900/60 text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40";

function selectedClasses(isSelected: boolean): string {
  return isSelected
    ? "border-emerald-400/40 ring-1 ring-emerald-400/25 bg-zinc-900/80"
    : "border-zinc-800 hover:border-zinc-700";
}

interface RailProps {
  accounts: AccountSummary[];
  selected: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deletingId: string | null;
}

export function AccountsRail({
  accounts,
  selected,
  onSelect,
  onDelete,
  deletingId,
}: RailProps) {
  const totalEquity = accounts.reduce((s, a) => s + (a.latest?.equity ?? 0), 0);
  const totalFloating = accounts.reduce(
    (s, a) => s + (a.latest?.floatingPnL ?? 0),
    0
  );

  return (
    <nav
      aria-label="Accounts"
      className="ts-scroll -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 lg:mx-0 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:px-0 lg:pb-0"
    >
      <AllAccountsCard
        accounts={accounts}
        totalEquity={totalEquity}
        totalFloating={totalFloating}
        isSelected={selected === ALL_ACCOUNTS}
        onSelect={() => onSelect(ALL_ACCOUNTS)}
      />
      {accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          isSelected={selected === account.id}
          onSelect={() => onSelect(account.id)}
          onDelete={() => onDelete(account.id)}
          deleting={deletingId === account.id}
        />
      ))}
    </nav>
  );
}

function AllAccountsCard({
  accounts,
  totalEquity,
  totalFloating,
  isSelected,
  onSelect,
}: {
  accounts: AccountSummary[];
  totalEquity: number;
  totalFloating: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        cardShell,
        "min-w-[290px] shrink-0 snap-start p-3.5 lg:min-w-0",
        selectedClasses(isSelected)
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-200">
          <Wallet className="size-4 text-zinc-500" aria-hidden />
          All accounts
        </span>
        <span className="text-[11px] tabular-nums text-zinc-500">
          {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
        </span>
      </div>
      <p className="mt-2.5 font-mono text-xl font-semibold tabular-nums text-zinc-100">
        {fmtMoney(totalEquity)}
      </p>
      <p
        className={cn(
          "mt-0.5 font-mono text-xs tabular-nums",
          pnlClass(totalFloating)
        )}
      >
        {fmtSigned(totalFloating)} floating
      </p>
      <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-2.5">
        {accounts.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-2 text-xs text-zinc-400"
          >
            <StatusDot status={a.status} />
            <span className="min-w-0 flex-1 truncate">{a.brokerName}</span>
            <PlatformBadge platform={a.platform} />
            <span className="w-[6.5rem] text-right font-mono tabular-nums text-zinc-300">
              {fmtMoney(a.latest?.equity ?? 0, a.currency)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountCard({
  account,
  isSelected,
  onSelect,
  onDelete,
  deleting,
}: {
  account: AccountSummary;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const floating = account.latest?.floatingPnL ?? 0;
  const statusLine = (
    <AccountStatusLine account={account} />
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        cardShell,
        "min-w-[290px] shrink-0 snap-start p-3.5 lg:min-w-0",
        selectedClasses(isSelected)
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <PlatformBadge platform={account.platform} />
          {account.demo && <DemoChip />}
        </div>
        <DeleteAccountButton
          account={account}
          onDelete={onDelete}
          deleting={deleting}
        />
      </div>
      <p className="mt-2 truncate text-sm font-semibold tracking-tight text-zinc-100">
        {account.brokerName}
      </p>
      <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
        #{account.login}
        <span className="mx-1.5 text-zinc-700">·</span>
        <span className="font-sans">{account.owner.name}</span>
      </p>
      <div className="mt-3 flex items-end justify-between gap-2">
        <span className="pb-0.5 text-[11px] text-zinc-500">Equity</span>
        <span className="font-mono text-lg font-semibold tabular-nums text-zinc-100">
          {fmtMoney(account.latest?.equity ?? 0, account.currency)}
        </span>
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="pb-px text-[11px] text-zinc-500">Floating P&amp;L</span>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            pnlClass(floating)
          )}
        >
          {fmtSigned(floating, account.currency)}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-800 pt-2.5">
        {statusLine}
        <span className="shrink-0 text-[10px] text-zinc-500">
          Synced {relTime(account.lastSyncAt)}
        </span>
      </div>
    </div>
  );
}

function AccountStatusLine({ account }: { account: AccountSummary }) {
  const dot = <StatusDot status={account.status} />;
  const label =
    account.status === "ACTIVE"
      ? "Active"
      : account.status === "PENDING"
        ? "Pending"
        : account.status === "PAUSED"
          ? "Paused"
          : "Error";

  if (account.status === "ERROR" && account.lastError) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 cursor-help items-center gap-1.5 text-[11px] text-rose-300">
            {dot}
            <span className="max-w-[7.5rem] truncate">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 border-zinc-700 bg-zinc-800 text-xs text-zinc-200">
          {account.lastError}
        </TooltipContent>
      </Tooltip>
    );
  }

  const tone =
    account.status === "ACTIVE"
      ? "text-emerald-300"
      : account.status === "PENDING"
        ? "text-amber-300"
        : account.status === "PAUSED"
          ? "text-zinc-300"
          : "text-rose-300";

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px]", tone)}>
      {dot}
      {label}
    </span>
  );
}

function DeleteAccountButton({
  account,
  onDelete,
  deleting,
}: {
  account: AccountSummary;
  onDelete: () => void;
  deleting: boolean;
}) {
  const label = useMemo(
    () => `Delete ${account.brokerName} account ${account.login}`,
    [account.brokerName, account.login]
  );
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-zinc-500 hover:bg-rose-400/10 hover:text-rose-300"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {deleting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete account?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes {account.brokerName} ({account.login}) and all stored
            snapshots, positions and trade history. This action cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="border border-rose-400/30 bg-rose-400/10 text-rose-300 hover:bg-rose-400/20"
            onClick={onDelete}
          >
            Delete account
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
