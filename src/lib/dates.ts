import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfYear,
  format,
  parseISO,
  startOfMonth,
  startOfYear,
  subMonths,
} from "date-fns";

/** Dates are handled as local calendar days in ISO "yyyy-MM-dd" form (Postgres `date`). */
export const toISODate = (d: Date) => format(d, "yyyy-MM-dd");
export const fromISODate = (s: string) => parseISO(s);
export const todayISO = () => toISODate(new Date());

export function dateGroupLabel(iso: string, today = new Date()): string {
  const d = fromISODate(iso);
  const diff = differenceInCalendarDays(today, d);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (d.getFullYear() === today.getFullYear()) return format(d, "EEE, MMMM d");
  return format(d, "EEE, MMMM d, yyyy");
}

export const formatLongDate = (iso: string) => format(fromISODate(iso), "EEEE, MMMM d, yyyy");
export const formatShortDate = (iso: string) => format(fromISODate(iso), "MMM d");
/** "Sep 27" this year, "Sep 27, 24" otherwise — for compact lists that span years. */
export const formatListDate = (iso: string, now = new Date()) => {
  const d = fromISODate(iso);
  return format(d, d.getFullYear() === now.getFullYear() ? "MMM d" : "MMM d, yy");
};
export const formatMediumDate = (iso: string) => format(fromISODate(iso), "MMM d, yyyy");

export type PeriodKey = "this_month" | "last_month" | "last_3_months" | "this_year" | "custom";
export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_3_months", label: "Last 3 months" },
  { value: "this_year", label: "This year" },
  { value: "custom", label: "Custom" },
];

export function periodRange(key: PeriodKey, custom?: { from?: string; to?: string }, now = new Date()): { from: string; to: string; label: string } {
  switch (key) {
    case "last_month": {
      const m = subMonths(now, 1);
      return { from: toISODate(startOfMonth(m)), to: toISODate(endOfMonth(m)), label: format(m, "MMMM yyyy") };
    }
    case "last_3_months": {
      const start = startOfMonth(subMonths(now, 2));
      return { from: toISODate(start), to: toISODate(endOfMonth(now)), label: `${format(start, "MMM")} – ${format(now, "MMM yyyy")}` };
    }
    case "this_year":
      return { from: toISODate(startOfYear(now)), to: toISODate(endOfYear(now)), label: format(now, "yyyy") };
    case "custom": {
      const from = custom?.from || toISODate(startOfMonth(now));
      const to = custom?.to || toISODate(endOfMonth(now));
      return { from, to, label: `${formatMediumDate(from)} – ${formatMediumDate(to)}` };
    }
    default:
      return { from: toISODate(startOfMonth(now)), to: toISODate(endOfMonth(now)), label: format(now, "MMMM yyyy") };
  }
}

/** Advance a date by one recurrence step. */
export function stepDate(d: Date, frequency: string, intervalValue = 1): Date {
  switch (frequency) {
    case "weekly":
      return addWeeks(d, 1);
    case "biweekly":
      return addWeeks(d, 2);
    case "monthly":
      return addMonths(d, 1);
    case "quarterly":
      return addMonths(d, 3);
    case "semiannual":
      return addMonths(d, 6);
    case "annual":
      return addMonths(d, 12);
    default:
      return addDays(d, Math.max(1, intervalValue));
  }
}

/** Step backwards (used to walk a schedule into the past from its anchor date). */
export function stepDateBack(d: Date, frequency: string, intervalValue = 1): Date {
  switch (frequency) {
    case "weekly":
      return addWeeks(d, -1);
    case "biweekly":
      return addWeeks(d, -2);
    case "monthly":
      return addMonths(d, -1);
    case "quarterly":
      return addMonths(d, -3);
    case "semiannual":
      return addMonths(d, -6);
    case "annual":
      return addMonths(d, -12);
    default:
      return addDays(d, -Math.max(1, intervalValue));
  }
}

/** Approximate occurrences per month, for "monthly equivalent" totals. */
export function monthlyFactor(frequency: string, intervalValue = 1): number {
  switch (frequency) {
    case "weekly":
      return 52 / 12;
    case "biweekly":
      return 26 / 12;
    case "monthly":
      return 1;
    case "quarterly":
      return 1 / 3;
    case "semiannual":
      return 1 / 6;
    case "annual":
      return 1 / 12;
    default:
      return 365.25 / 12 / Math.max(1, intervalValue);
  }
}

/** Typical tolerance (days) when matching an actual transaction to an expected occurrence. */
export function matchWindowDays(frequency: string, intervalValue = 1): number {
  switch (frequency) {
    case "weekly":
      return 2;
    case "biweekly":
      return 4;
    case "custom":
      return Math.max(1, Math.min(7, Math.floor(intervalValue / 4)));
    default:
      return 6;
  }
}
