import { format, formatDistanceToNowStrict, parse } from "date-fns";

/** Intl formatters cached per currency to avoid re-creation on every render. */
const currencyFormatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string): Intl.NumberFormat {
  let fmt = currencyFormatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    currencyFormatters.set(currency, fmt);
  }
  return fmt;
}

const compactCurrencyFormatters = new Map<string, Intl.NumberFormat>();

function compactCurrencyFormatter(currency: string): Intl.NumberFormat {
  let fmt = compactCurrencyFormatters.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    });
    compactCurrencyFormatters.set(currency, fmt);
  }
  return fmt;
}

const numberFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Format an amount of money, e.g. -1234.5 -> "-$1,234.50". */
export function fmtMoney(value: number, currency = "USD"): string {
  return currencyFormatter(currency).format(value);
}

/** Compact money for chart axes, e.g. 298722 -> "$298.7K". */
export function fmtMoneyCompact(value: number, currency = "USD"): string {
  return compactCurrencyFormatter(currency).format(value);
}

/** Signed money: positive values get an explicit "+". */
export function fmtSigned(value: number, currency = "USD"): string {
  const base = currencyFormatter(currency).format(value);
  return value > 0 ? `+${base}` : base;
}

/** Plain number with fixed decimals, e.g. 54.267 -> "54.27". */
export function fmtNum(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Percentage, e.g. 69.2 -> "69.20%". */
export function fmtPct(value: number, digits = 2): string {
  return `${fmtNum(value, digits)}%`;
}

/** Price with instrument-appropriate precision (fx 5 digits, indices 2). */
export function fmtPrice(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value >= 500 ? 2 : 5,
    maximumFractionDigits: value >= 500 ? 2 : 5,
  }).format(value);
}

/** Full date-time for footers/labels: "16 Nov 2026, 23:34". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "d MMM yyyy, HH:mm");
}

/** Short date-time for dense tables: "16 Nov 26, 19:26". */
export function fmtDateTimeShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : format(d, "d MMM yy, HH:mm");
}

/** Relative time, e.g. "2 hours ago". Returns "never" for null. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return `${formatDistanceToNowStrict(d)} ago`;
}

/** "2026-08" -> "Aug 26" for chart axes / tooltips. */
export function fmtMonthLabel(month: string): string {
  try {
    return format(parse(`${month}-01`, "yyyy-MM-dd", new Date()), "MMM yy");
  } catch {
    return month;
  }
}

/** "2026-08" -> "August 2026" for tooltips. */
export function fmtMonthLong(month: string): string {
  try {
    return format(parse(`${month}-01`, "yyyy-MM-dd", new Date()), "MMMM yyyy");
  } catch {
    return month;
  }
}

/** Consistent tone classes for positive / negative / neutral figures. */
export function pnlTextClass(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-zinc-400";
}
