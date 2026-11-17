/** Shared API contract types used by both route handlers and the dashboard UI. */

export type Platform = "MT4" | "MT5";
export type AccountStatus = "PENDING" | "ACTIVE" | "ERROR" | "PAUSED";

export interface OwnerDTO {
  id: string;
  name: string;
}

export interface LatestSnapshotDTO {
  ts: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  floatingPnL: number;
  openPositions: number;
}

export interface AccountSummary {
  id: string;
  owner: OwnerDTO;
  platform: Platform;
  brokerName: string;
  serverName: string | null;
  serverHost: string | null;
  serverPort: number | null;
  login: string;
  currency: string;
  leverage: number | null;
  status: AccountStatus;
  lastError: string | null;
  lastSyncAt: string | null;
  demo: boolean;
  createdAt: string;
  latest: LatestSnapshotDTO | null;
}

export interface PositionDTO {
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  currentPrice: number;
  openTime: string;
  profit: number;
  swap: number;
  comment: string | null;
}

export interface TradeDTO {
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  closePrice: number;
  openTime: string;
  closeTime: string;
  profit: number;
  commission: number;
  swap: number;
  net: number;
  comment: string | null;
}

export interface EquityPointDTO {
  ts: string;
  balance: number;
  equity: number;
}

export interface SymbolStatDTO {
  symbol: string;
  trades: number;
  net: number;
  winRate: number;
  volume: number;
}

export interface MonthStatDTO {
  month: string; // "2025-01"
  net: number;
  trades: number;
}

export interface StatsDTO {
  startBalance: number;
  balance: number;
  equity: number;
  floatingPnL: number;
  netProfit: number;
  returnPct: number;

  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  profitFactor: number | null; // null when no losses
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  maxConsecWins: number;
  maxConsecLosses: number;

  longTrades: number;
  shortTrades: number;
  longNet: number;
  shortNet: number;

  maxDrawdownPct: number;
  maxDrawdownAbs: number;
  sharpe: number | null; // annualized daily-return Sharpe, rf=0
  recoveryFactor: number | null;

  totalVolume: number;
  commissionTotal: number;
  swapTotal: number;

  bestTrade: number;
  worstTrade: number;

  bySymbol: SymbolStatDTO[];
  byMonth: MonthStatDTO[];
}

export interface ReportDTO {
  account: AccountSummary;
  equityCurve: EquityPointDTO[];
  stats: StatsDTO;
  positions: PositionDTO[];
  trades: TradeDTO[];
}

export interface ResolvedEndpoint {
  host: string;
  port: number;
}

export interface ResolutionResult {
  source: "metaquotes" | "srv-upload" | "manual" | "none";
  endpoints: ResolvedEndpoint[];
  note?: string;
}

export interface BrokerSearchItem {
  name: string;
  platform: Platform;
  detail?: string;
}

/** ---- collector <-> app contracts ---- */

export interface CollectorAccountConfig {
  id: string;
  platform: Platform;
  brokerName: string;
  serverName: string | null;
  serverHost: string | null;
  serverPort: number | null;
  login: string;
  password: string; // decrypted server-side only
  backfillFrom: string; // ISO
  pollMinutes: number;
}

export interface IngestAccountInfo {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  leverage?: number;
  currency?: string;
}

export interface IngestPosition {
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  currentPrice: number;
  openTime: string;
  profit: number;
  swap: number;
  comment?: string | null;
}

export interface IngestTrade {
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  closePrice: number;
  openTime: string;
  closeTime: string;
  profit: number;
  commission: number;
  swap: number;
  comment?: string | null;
}

export interface IngestPayload {
  accountId?: string;
  /** Agent mode: resolve the account by login instead of the internal id. */
  login?: string;
  platform?: Platform;
  /** Broker server label/host (disambiguates when the same login exists twice). */
  server?: string;
  ts?: string;
  accountInfo: IngestAccountInfo;
  positions: IngestPosition[];
  trades: IngestTrade[];
  status?: AccountStatus;
  error?: string | null;
}

export interface AgentAccountDTO {
  id: string;
  login: string;
  platform: Platform;
  brokerName: string;
  serverName: string | null;
  status: AccountStatus;
  lastSyncAt: string | null;
}

export interface AgentConfigDTO {
  ok: boolean;
  ingestUrl: string;
  tokenRequired: boolean;
  /** Only present when EXPOSE_INGEST_TOKEN=1 (self-host convenience). */
  token?: string;
  accounts: AgentAccountDTO[];
}
