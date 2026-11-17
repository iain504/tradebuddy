import type { EquityPointDTO, MonthStatDTO, StatsDTO, SymbolStatDTO, TradeDTO } from "./types";

/**
 * Performance analytics computed from normalized closed trades + equity snapshots.
 * All pure functions - no I/O.
 */

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeStats(
  trades: TradeDTO[],
  equityCurve: EquityPointDTO[],
  current: { balance: number; equity: number; floatingPnL: number }
): StatsDTO {
  const sorted = [...trades].sort((a, b) => +new Date(a.closeTime) - +new Date(b.closeTime));

  const nets = sorted.map((t) => t.net);
  const totalTrades = sorted.length;
  const wins = sorted.filter((t) => t.net > 0);
  const losses = sorted.filter((t) => t.net < 0);
  const winTrades = wins.length;
  const lossTrades = losses.length;

  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = losses.reduce((s, t) => s + t.net, 0); // negative

  const avgWin = winTrades ? grossWin / winTrades : 0;
  const avgLoss = lossTrades ? grossLoss / lossTrades : 0;
  const largestWin = wins.reduce((m, t) => Math.max(m, t.net), 0);
  const largestLoss = losses.reduce((m, t) => Math.min(m, t.net), 0);

  // streaks
  let maxConsecWins = 0;
  let maxConsecLosses = 0;
  let cw = 0;
  let cl = 0;
  for (const t of sorted) {
    if (t.net > 0) {
      cw += 1;
      cl = 0;
    } else if (t.net < 0) {
      cl += 1;
      cw = 0;
    }
    maxConsecWins = Math.max(maxConsecWins, cw);
    maxConsecLosses = Math.max(maxConsecLosses, cl);
  }

  // long/short
  const longs = sorted.filter((t) => t.side === "BUY");
  const shorts = sorted.filter((t) => t.side === "SELL");

  // drawdown from equity curve (prefer equity; fall back to balance)
  let startBalance = current.balance;
  let peak = -Infinity;
  let maxDDAbs = 0;
  for (const p of equityCurve) {
    const v = p.equity || p.balance;
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDDAbs) maxDDAbs = dd;
  }
  if (equityCurve.length === 0 && totalTrades > 0) {
    // rebuild pseudo equity from trades if no snapshots
    let eq = sorted[0] ? Math.max(1, current.balance - nets.reduce((s, n) => s + n, 0)) : current.balance;
    peak = eq;
    for (const t of sorted) {
      eq += t.net;
      if (eq > peak) peak = eq;
      const dd = peak - eq;
      if (dd > maxDDAbs) maxDDAbs = dd;
    }
  }
  const firstPoint = equityCurve[0];
  if (firstPoint) startBalance = firstPoint.balance;

  const maxDDPct = peak > 0 ? (maxDDAbs / peak) * 100 : 0;

  // Sharpe from daily equity (last observation per UTC day)
  let sharpe: number | null = null;
  if (equityCurve.length >= 30) {
    const byDay = new Map<string, number>();
    for (const p of equityCurve) byDay.set(dayKey(new Date(p.ts)), p.equity || p.balance);
    const days = [...byDay.keys()].sort();
    if (days.length >= 20) {
      const rets: number[] = [];
      for (let i = 1; i < days.length; i++) {
        const prev = byDay.get(days[i - 1])!;
        const cur = byDay.get(days[i])!;
        if (prev > 0) rets.push(cur / prev - 1);
      }
      if (rets.length >= 10) {
        const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
        const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1);
        const std = Math.sqrt(variance);
        if (std > 0) sharpe = (mean / std) * Math.sqrt(252);
      }
    }
  }

  // per-symbol
  const symMap = new Map<string, { trades: number; net: number; wins: number; volume: number }>();
  for (const t of sorted) {
    const s = symMap.get(t.symbol) || { trades: 0, net: 0, wins: 0, volume: 0 };
    s.trades += 1;
    s.net += t.net;
    s.volume += t.volume;
    if (t.net > 0) s.wins += 1;
    symMap.set(t.symbol, s);
  }
  const bySymbol: SymbolStatDTO[] = [...symMap.entries()]
    .map(([symbol, s]) => ({
      symbol,
      trades: s.trades,
      net: round2(s.net),
      winRate: s.trades ? round1((s.wins / s.trades) * 100) : 0,
      volume: round2(s.volume),
    }))
    .sort((a, b) => b.net - a.net);

  // per-month
  const monMap = new Map<string, { net: number; trades: number }>();
  for (const t of sorted) {
    const k = new Date(t.closeTime).toISOString().slice(0, 7);
    const s = monMap.get(k) || { net: 0, trades: 0 };
    s.net += t.net;
    s.trades += 1;
    monMap.set(k, s);
  }
  const byMonth: MonthStatDTO[] = [...monMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, s]) => ({ month, net: round2(s.net), trades: s.trades }));

  const netProfit = current.balance - startBalance + (equityCurve.length === 0 ? 0 : 0);
  const totalVolume = sorted.reduce((s, t) => s + t.volume, 0);
  const commissionTotal = sorted.reduce((s, t) => s + t.commission, 0);
  const swapTotal = sorted.reduce((s, t) => s + t.swap, 0);

  return {
    startBalance: round2(startBalance),
    balance: round2(current.balance),
    equity: round2(current.equity),
    floatingPnL: round2(current.floatingPnL),
    netProfit: round2(netProfit),
    returnPct: startBalance ? round2((netProfit / startBalance) * 100) : 0,

    totalTrades,
    winTrades,
    lossTrades,
    winRate: totalTrades ? round1((winTrades / totalTrades) * 100) : 0,
    profitFactor: grossLoss < 0 ? round2(grossWin / Math.abs(grossLoss)) : null,
    expectancy: totalTrades ? round2(nets.reduce((s, n) => s + n, 0) / totalTrades) : 0,
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    largestWin: round2(largestWin),
    largestLoss: round2(largestLoss),
    maxConsecWins,
    maxConsecLosses,

    longTrades: longs.length,
    shortTrades: shorts.length,
    longNet: round2(longs.reduce((s, t) => s + t.net, 0)),
    shortNet: round2(shorts.reduce((s, t) => s + t.net, 0)),

    maxDrawdownAbs: round2(maxDDAbs),
    maxDrawdownPct: round2(maxDDPct),
    sharpe: sharpe !== null ? round2(sharpe) : null,
    recoveryFactor: maxDDAbs > 0 ? round2(netProfit / maxDDAbs) : null,

    totalVolume: round2(totalVolume),
    commissionTotal: round2(commissionTotal),
    swapTotal: round2(swapTotal),

    bestTrade: round2(nets.length ? Math.max(...nets) : 0),
    worstTrade: round2(nets.length ? Math.min(...nets) : 0),

    bySymbol,
    byMonth,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
