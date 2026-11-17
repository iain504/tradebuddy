import type {
  AccountSummary,
  BrokerSearchItem,
  ReportDTO,
  ResolvedEndpoint,
} from "@/lib/types";

/** Ranges supported by GET /api/accounts/:id/report */
export const RANGES = ["1M", "3M", "6M", "1Y", "ALL"] as const;
export type ReportRange = (typeof RANGES)[number];

export interface HealthDTO {
  ok: boolean;
  collectorConfigured: boolean;
}

export interface SyncResultDTO {
  ok: boolean;
  mode: "demo" | "queued" | "collector";
  message?: string;
}

export interface BrokerSearchResultDTO {
  reachable: boolean;
  items: BrokerSearchItem[];
  note?: string;
}

export interface SrvDecodeResultDTO {
  ok: boolean;
  name?: string;
  endpoints?: ResolvedEndpoint[];
  error?: string;
}

export interface CreateAccountResultDTO {
  account: AccountSummary;
  resolution: {
    source: "metaquotes" | "srv-upload" | "manual" | "none";
    endpoints: ResolvedEndpoint[];
    note?: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err.length > 0) return err;
  }
  return `Request failed (${status})`;
}

/** Typed JSON fetch wrapper that throws ApiError with the server's message. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(extractError(body, res.status), res.status);
  return body as T;
}
