"use client";

import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for the accounts rail (used on first load and empty+seeding state). */
export function RailSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-3"
    >
      {Array.from({ length: cards }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5"
        >
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-14" />
          </div>
          <Skeleton className="mt-3 h-5 w-40" />
          <Skeleton className="mt-2 h-3 w-28" />
          <div className="mt-4 flex items-end justify-between">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-6 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton for the report / aggregate panel. */
export function DetailSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="mt-2 h-3 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5"
          >
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2.5 h-6 w-24" />
            <Skeleton className="mt-2 h-3 w-14" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-4 h-[320px] w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5"
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
