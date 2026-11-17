import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import type { Platform } from "./types";

/**
 * Demo simulator.
 *
 * Generates realistic trading history (trades, daily snapshots, open positions)
 * for three demo accounts so the whole pipeline - ingest, storage, statistics,
 * UI - can be exercised without live broker connectivity. "Fetch now" on a demo
 * account advances the simulation instead of calling the collector.
 */

interface SymCfg {
  name: string;
  weight: number;
  price: number;
  contract: number; // USD per 1.0 price move per 1.0 lot
  vol: number; // daily price volatility fraction
}

const SYMBOLS: SymCfg[] = [
  { name: "EURUSD", weight: 22, price: 1.0847, contract: 100000, vol: 0.005 },
  { name: "GBPUSD", weight: 14, price: 1.2693, contract: 100000, vol: 0.006 },
  { name: "USDJPY", weight: 12, price: 157.24, contract: 640, vol: 0.005 }, // USD-quoted-in-XXX: $640 per 1.0 move per lot (100k/157)
  { name: "AUDUSD", weight: 8, price: 0.6654, contract: 100000, vol: 0.007 },
  { name: "XAUUSD", weight: 18, price: 2387.5, contract: 100, vol: 0.011 },
  { name: "XAGUSD", weight: 5, price: 28.41, contract: 5000, vol: 0.016 },
  { name: "US500", weight: 9, price: 5451.2, contract: 10, vol: 0.009 },
  { name: "US30", weight: 5, price: 39210, contract: 5, vol: 0.008 },
  { name: "BTCUSD", weight: 4, price: 67240, contract: 1, vol: 0.03 },
  { name: "ETHUSD", weight: 3, price: 3521, contract: 10, vol: 0.035 },
];

function pickSymbol(): SymCfg {
  const total = SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const s of SYMBOLS) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return SYMBOLS[0];
}

interface DemoAccountSpec {
  platform: Platform;
  brokerName: string;
  serverName: string;
  login: string;
  currency: string;
  leverage: number;
  startBalance: number;
  months: number;
  tradesPerMonth: number;
  winRate: number; // 0..1
  riskPct: number; // fraction of startBalance risked per trade (approx avg outcome scale)
  tailFactor: number; // how fat the right tail of winners is
  commissionPerLot: number;
  longBias: number; // 0..1 probability of BUY
  statusNote: string;
}

const DEMO_SPECS: DemoAccountSpec[] = [
  {
    platform: "MT5",
    brokerName: "ICMarkets SC",
    serverName: "ICMarketsSC-MT5",
    login: "51823041",
    currency: "USD",
    leverage: 500,
    startBalance: 100000,
    months: 10,
    tradesPerMonth: 22,
    winRate: 0.56,
    riskPct: 0.011,
    tailFactor: 2.6,
    commissionPerLot: 3.5,
    longBias: 0.55,
    statusNote: "Swing FX + metals, mechanical stop-based entries",
  },
  {
    platform: "MT4",
    brokerName: "Pepperstone",
    serverName: "Pepperstone-Razor",
    login: "73019945",
    currency: "USD",
    leverage: 200,
    startBalance: 50000,
    months: 10,
    tradesPerMonth: 16,
    winRate: 0.47,
    riskPct: 0.014,
    tailFactor: 3.1,
    commissionPerLot: 3.0,
    longBias: 0.5,
    statusNote: "Index breakout system, trend-following",
  },
  {
    platform: "MT5",
    brokerName: "FP Markets",
    serverName: "FPMP5-Live",
    login: "11042886",
    currency: "USD",
    leverage: 100,
    startBalance: 12000,
    months: 8,
    tradesPerMonth: 38,
    winRate: 0.68,
    riskPct: 0.02,
    tailFactor: 1.15,
    commissionPerLot: 4.0,
    longBias: 0.6,
    statusNote: "Intraday gold scalper, high frequency",
  },
];

interface GenTrade {
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  closePrice: number;
  openTime: Date;
  closeTime: Date;
  profit: number;
  commission: number;
  swap: number;
  net: number;
  comment: string | null;
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function genTrades(spec: DemoAccountSpec, startBalance: number): GenTrade[] {
  const trades: GenTrade[] = [];
  const now = new Date();
  const monthsAgo = new Date(now);
  monthsAgo.setMonth(monthsAgo.getMonth() - spec.months);
  let cursor = new Date(monthsAgo);
  let ticket = 100000000 + Math.floor(Math.random() * 1000000);

  while (cursor < now) {
    const n = Math.max(4, Math.round(spec.tradesPerMonth * (0.7 + Math.random() * 0.6)));
    for (let i = 0; i < n && cursor < now; i++) {
      const sym = pickSymbol();
      const side: "BUY" | "SELL" = Math.random() < spec.longBias ? "BUY" : "SELL";

      // trade timestamp: random hour, weekdays weighted
      const t = new Date(cursor);
      t.setHours(6 + Math.floor(Math.random() * 14), Math.floor(Math.random() * 60), 0, 0);
      if (t > now) break;

      const holdHours = 1 + Math.floor(Math.random() * 46);
      const closeTime = new Date(t.getTime() + holdHours * 3600 * 1000);
      if (closeTime > now) continue;

      // move over holding period
      const movePct = sym.vol * Math.sqrt(holdHours / 24) * (0.4 + Math.random() * 1.6);
      const dir = side === "BUY" ? 1 : -1;

      const isWin = Math.random() < spec.winRate;
      const risk = spec.startBalance * spec.riskPct * (0.6 + Math.random() * 0.9);
      let pnl: number;
      if (isWin) {
        pnl = risk * (0.6 + Math.pow(Math.random(), 2.2) * spec.tailFactor * 2);
      } else {
        pnl = -risk * (0.7 + Math.random() * 0.55);
      }

      // volume so that pnl ~= movePct * contract * volume
      const grossMove = movePct * sym.price;
      const volume = Math.max(0.01, Math.min(20, Math.abs(pnl) / Math.max(1e-9, grossMove * sym.contract)));
      const priceMove = grossMove * dir * (isWin ? 1 : -1);
      const openPrice = round(sym.price * (1 + (Math.random() - 0.5) * sym.vol * 2), sym.price > 500 ? 2 : 5);
      const closePrice = round(openPrice + priceMove, sym.price > 500 ? 2 : 5);
      const profit = round(pnl);
      const commission = round(-spec.commissionPerLot * volume);
      const swap = round(-Math.max(0, holdHours - 12) * volume * (0.4 + Math.random() * 1.6) * (sym.name === "XAUUSD" ? 2 : 1));

      trades.push({
        positionId: String(ticket++),
        symbol: sym.name,
        side,
        volume: round(volume, 2),
        openPrice,
        closePrice,
        openTime: t,
        closeTime,
        profit,
        commission,
        swap,
        net: round(profit + commission + swap),
        comment: Math.random() < 0.12 ? spec.statusNote.slice(0, 26) : null,
      });

      cursor = new Date(cursor.getTime() + (28 * 24 * 3600 * 1000 * (1 / n)) * (0.8 + Math.random() * 0.4));
    }
    cursor.setMonth(cursor.getMonth() + 1);
    cursor.setDate(1);
  }
  return trades.sort((a, b) => +a.closeTime - +b.closeTime);
}

function dailySnapshots(spec: DemoAccountSpec, trades: GenTrade[], startBalance: number) {
  const points: {
    ts: Date;
    balance: number;
    equity: number;
    floatingPnL: number;
    openPositions: number;
    margin: number;
    freeMargin: number;
    marginLevel: number | null;
  }[] = [];
  const start = new Date(trades[0]?.openTime || new Date(Date.now() - spec.months * 30 * 86400e3));
  start.setUTCHours(0, 5, 0, 0);
  const now = new Date();

  let idx = 0;
  let balance = startBalance;
  const end = new Date(Math.min(+now, Date.now()));
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    while (idx < trades.length && trades[idx].closeTime <= d) {
      balance += trades[idx].net;
      idx++;
    }
    const floating = round(balance * (Math.random() - 0.45) * 0.004);
    const openPositions = Math.random() < 0.55 ? 1 + Math.floor(Math.random() * 4) : 0;
    const margin = round(openPositions * balance * 0.02 * Math.random());
    const equity = round(balance + floating);
    points.push({
      ts: new Date(d),
      balance: round(balance),
      equity,
      floatingPnL: floating,
      openPositions,
      margin,
      freeMargin: round(equity - margin),
      marginLevel: margin > 0 ? round((equity / margin) * 100, 1) : null,
    });
  }
  return points;
}

function genOpenPositions(spec: DemoAccountSpec) {
  const n = 2 + Math.floor(Math.random() * 3);
  const out: {
    positionId: string;
    symbol: string;
    side: "BUY" | "SELL";
    volume: number;
    openPrice: number;
    currentPrice: number;
    openTime: Date;
    profit: number;
    swap: number;
    comment: string | null;
  }[] = [];
  let ticket = 200000000 + Math.floor(Math.random() * 1000000);
  for (let i = 0; i < n; i++) {
    const sym = pickSymbol();
    const side: "BUY" | "SELL" = Math.random() < spec.longBias ? "BUY" : "SELL";
    const volume = round(0.1 + Math.random() * (spec.startBalance > 50000 ? 3 : 1), 2);
    const openPrice = round(sym.price * (1 + (Math.random() - 0.5) * sym.vol), sym.price > 500 ? 2 : 5);
    const drift = sym.price * sym.vol * (Math.random() - 0.45) * 1.4;
    const currentPrice = round(openPrice + drift, sym.price > 500 ? 2 : 5);
    const dir = side === "BUY" ? 1 : -1;
    const profit = round((currentPrice - openPrice) * dir * sym.contract * volume);
    const openTime = new Date(Date.now() - Math.floor(Math.random() * 96) * 3600 * 1000);
    out.push({
      positionId: String(ticket++),
      symbol: sym.name,
      side,
      volume,
      openPrice,
      currentPrice,
      openTime,
      profit,
      swap: round(-Math.random() * 4 * volume),
      comment: null,
    });
  }
  return out;
}

export async function ensureDemoData(): Promise<{ created: boolean; accounts: number }> {
  const existing = await db.account.count({ where: { demo: true } });
  if (existing > 0) return { created: false, accounts: existing };

  const user = await db.user.upsert({
    where: { name: "Demo Trader" },
    update: {},
    create: { name: "Demo Trader" },
  });

  let count = 0;
  for (const spec of DEMO_SPECS) {
    const exists = await db.account.findFirst({
      where: { userId: user.id, login: spec.login, platform: spec.platform },
    });
    if (exists) continue;

    const account = await db.account.create({
      data: {
        userId: user.id,
        platform: spec.platform,
        brokerName: spec.brokerName,
        serverName: spec.serverName,
        login: spec.login,
        passwordEnc: encrypt("investor-demo-password"),
        currency: spec.currency,
        leverage: spec.leverage,
        status: "ACTIVE",
        demo: true,
        backfillFrom: new Date(Date.now() - spec.months * 30 * 86400e3),
        lastSyncAt: new Date(),
      },
    });

    const trades = genTrades(spec, spec.startBalance);
    const snaps = dailySnapshots(spec, trades, spec.startBalance);
    const positions = genOpenPositions(spec);

    if (trades.length) {
      await db.trade.createMany({
        data: trades.map((t) => ({ ...t, accountId: account.id })),
      });
    }
    if (snaps.length) {
      await db.snapshot.createMany({
        data: snaps.map((s) => ({ ...s, accountId: account.id })),
      });
    }
    if (positions.length) {
      await db.position.createMany({
        data: positions.map((p) => ({ ...p, accountId: account.id })),
      });
    }
    count++;
  }
  return { created: true, accounts: count };
}

/**
 * Advance a demo account one sync cycle: random-walk open positions,
 * close some into trades, open new ones, upsert a fresh snapshot.
 */
export async function advanceDemo(accountId: string): Promise<void> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    include: { positions: true, snapshots: { orderBy: { ts: "desc" }, take: 1 } },
  });
  if (!account || !account.demo) return;

  const symbolCfg = (name: string) => SYMBOLS.find((s) => s.name === name) || SYMBOLS[0];
  let balance = account.snapshots[0]?.balance ?? 10000;
  const now = new Date();

  for (const p of account.positions) {
    const sym = symbolCfg(p.symbol);
    const drift = sym.price * sym.vol * (Math.random() - 0.48) * 0.55;
    const currentPrice = round(p.currentPrice + drift, p.currentPrice > 500 ? 2 : 5);
    const dir = p.side === "BUY" ? 1 : -1;
    const profit = round((currentPrice - p.openPrice) * dir * sym.contract * p.volume);

    if (Math.random() < 0.28) {
      // close into a trade
      const commission = round(-4 * p.volume);
      const net = round(profit + p.swap + commission);
      await db.trade.upsert({
        where: { accountId_positionId: { accountId: account.id, positionId: p.positionId } },
        update: {},
        create: {
          accountId: account.id,
          positionId: p.positionId,
          symbol: p.symbol,
          side: p.side,
          volume: p.volume,
          openPrice: p.openPrice,
          closePrice: currentPrice,
          openTime: p.openTime,
          closeTime: now,
          profit,
          commission,
          swap: p.swap,
          net,
          comment: p.comment,
        },
      });
      balance += net;
      await db.position.delete({ where: { id: p.id } });
    } else {
      await db.position.update({
        where: { id: p.id },
        data: { currentPrice, profit },
      });
    }
  }

  // occasionally open a new position
  if (Math.random() < 0.3) {
    const sym = pickSymbol();
    const side: "BUY" | "SELL" = Math.random() < 0.55 ? "BUY" : "SELL";
    const volume = round(0.1 + Math.random() * 2, 2);
    const openPrice = round(sym.price * (1 + (Math.random() - 0.5) * sym.vol * 0.3), sym.price > 500 ? 2 : 5);
    const currentPrice = round(openPrice + sym.price * sym.vol * (Math.random() - 0.5) * 0.2, sym.price > 500 ? 2 : 5);
    const dir = side === "BUY" ? 1 : -1;
    await db.position.upsert({
      where: {
        accountId_positionId: { accountId: account.id, positionId: String(900000000 + Math.floor(Math.random() * 999)) },
      },
      update: {},
      create: {
        accountId: account.id,
        positionId: String(900000000 + Math.floor(Math.random() * 999999)),
        symbol: sym.name,
        side,
        volume,
        openPrice,
        currentPrice,
        openTime: now,
        profit: round((currentPrice - openPrice) * dir * sym.contract * volume),
        swap: 0,
        comment: null,
      },
    });
  }

  // fresh snapshot
  const refreshed = await db.position.findMany({ where: { accountId: account.id } });
  const floating = round(refreshed.reduce((s, p) => s + p.profit + p.swap, 0));
  const margin = round(refreshed.reduce((s, p) => {
    const sym = symbolCfg(p.symbol);
    return s + (p.openPrice * sym.contract * p.volume) / (account.leverage || 100);
  }, 0));
  const equity = round(balance + floating);

  const existingSnap = await db.snapshot.findFirst({
    where: { accountId: account.id, ts: { gte: new Date(now.getTime() - 60000) } },
  });
  const snapData = {
    balance: round(balance),
    equity,
    margin,
    freeMargin: round(equity - margin),
    marginLevel: margin > 0 ? round((equity / margin) * 100, 1) : null,
    floatingPnL: floating,
    openPositions: refreshed.length,
  };
  if (existingSnap) {
    await db.snapshot.update({ where: { id: existingSnap.id }, data: snapData });
  } else {
    await db.snapshot.create({ data: { ...snapData, ts: now, accountId: account.id } });
  }

  await db.account.update({
    where: { id: account.id },
    data: { lastSyncAt: now, status: "ACTIVE", lastError: null },
  });
}
