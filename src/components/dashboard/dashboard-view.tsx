"use client";

import { ArrowRight, Repeat } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { BusinessDashboard } from "@/components/dashboard/business-dashboard";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { Page, SectionHeading } from "@/components/layout/app-shell";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { CategoryBars, rollupSpending } from "@/components/shared/category-bars";
import { MiniTransactionList } from "@/components/shared/mini-transaction-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatShortDate, monthlyFactor, PERIOD_OPTIONS, periodRange, todayISO, type PeriodKey } from "@/lib/dates";
import { EVENT_TYPE_COLORS, isLiability, ACCOUNT_TYPES, type AccountType } from "@/lib/domain";
import { formatMoney, formatSigned } from "@/lib/money";
import {
  useCalendarEvents,
  useCashflow,
  useLargestTransactions,
  useMonthlyCashflow,
  useRecentTransactions,
  useSpendingByCategory,
} from "@/lib/queries/analytics";
import { useAccounts, useCategoryIndex, useRecurringItems } from "@/lib/queries/reference";
import { useUnreviewedCount } from "@/lib/queries/transactions";
import { addDays } from "date-fns";
import { toISODate } from "@/lib/dates";

/** Personal workspaces get the household dashboard; business workspaces the P&L one. */
export function DashboardView() {
  const { isBusiness } = useWorkspace();
  return isBusiness ? <BusinessDashboard /> : <PersonalDashboard />;
}

/** The dashboard period, kept in the URL (?period=, ?from=, ?to=). */
export function useDashboardPeriod() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const period = (PERIOD_OPTIONS.some((o) => o.value === params.get("period")) ? params.get("period") : "this_month") as PeriodKey;
  const range = periodRange(period, { from: params.get("from") ?? undefined, to: params.get("to") ?? undefined });
  const setParam = (patch: Record<string, string>) => {
    const sp = new URLSearchParams(params.toString());
    Object.entries(patch).forEach(([k, v]) => (v ? sp.set(k, v) : sp.delete(k)));
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };
  return { period, range, setParam };
}

export function DashboardHeader({ eyebrow, period, range, setParam }: { eyebrow: string } & ReturnType<typeof useDashboardPeriod>) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-[12px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{eyebrow}</p>
        <h1 className="mt-1 font-serif text-[28px] leading-tight">{range.label}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Period"
          className="w-40"
          value={period}
          onChange={(e) => setParam({ period: e.target.value === "this_month" ? "" : e.target.value })}
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        {period === "custom" ? (
          <>
            <Input type="date" aria-label="From" className="w-40" value={range.from} onChange={(e) => setParam({ from: e.target.value })} />
            <Input type="date" aria-label="To" className="w-40" value={range.to} onChange={(e) => setParam({ to: e.target.value })} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function PersonalDashboard() {
  const periodState = useDashboardPeriod();
  const { period, range } = periodState;

  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const cats = useCategoryIndex();
  const cash = useCashflow(range.from, range.to);
  const byCat = useSpendingByCategory(range.from, range.to);
  const monthly = useMonthlyCashflow(todayISO(), 12);
  const recent = useRecentTransactions(8);
  const largest = useLargestTransactions(range.from, range.to);
  const recurring = useRecurringItems();

  const balances = useMemo(() => {
    const active = (accounts ?? []).filter((a) => a.active);
    const assets = active.filter((a) => !isLiability(a.account_type)).reduce((s, a) => s + a.current_balance, 0);
    const liabilities = active.filter((a) => isLiability(a.account_type)).reduce((s, a) => s + a.current_balance, 0);
    const cards = active.filter((a) => a.account_type === "credit_card").reduce((s, a) => s + a.current_balance, 0);
    return { assets, liabilities, cards, net: assets - liabilities, unset: active.filter((a) => !a.balance_as_of && a.current_balance === 0).length };
  }, [accounts]);

  const rollup = useMemo(() => rollupSpending(byCat.data ?? [], cats), [byCat.data, cats]);
  const subs = useMemo(() => {
    const items = (recurring.data ?? []).filter((r) => r.active && r.recurring_type === "subscription");
    const monthlyEq = items.reduce((s, r) => s + r.expected_amount * monthlyFactor(r.frequency, r.interval_value), 0);
    return { count: items.length, monthly: monthlyEq, annual: monthlyEq * 12 };
  }, [recurring.data]);

  const noData = !accountsLoading && (accounts ?? []).length === 0;

  if (noData) {
    return (
      <Page>
        <EmptyState
          title="Nothing here yet."
          body="Import your transaction history to populate the ledger, then this page fills in with spending, balances and upcoming bills."
          action={
            <Link href="/settings/import">
              <Button variant="primary">Import a CSV</Button>
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page wide>
      <DashboardHeader eyebrow="Overview" {...periodState} />

      {/* Headline figures — a ledger line, not a wall of cards */}
      <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-3 lg:grid-cols-6">
        <Figure label="Net worth" value={balances.net} signed loading={accountsLoading} strong />
        <Figure label="Assets" value={balances.assets} loading={accountsLoading} />
        <Figure label="Liabilities" value={balances.liabilities} loading={accountsLoading} />
        <Figure label={`Spent · ${period === "this_month" ? "this month" : "period"}`} value={cash.data?.spending} loading={cash.isLoading} />
        <Figure label={`Income · ${period === "this_month" ? "this month" : "period"}`} value={cash.data?.income} loading={cash.isLoading} />
        <Figure label="Credit card balances" value={balances.cards} loading={accountsLoading} />
      </dl>
      {balances.unset ? (
        <p className="mt-2 text-[12.5px] text-ink-3">
          {balances.unset} account{balances.unset === 1 ? " has" : "s have"} no balance yet —{" "}
          <Link href="/accounts" className="text-accent hover:underline">
            set balances
          </Link>{" "}
          for accurate net worth.
        </p>
      ) : null}

      <div className="mt-10 grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-10">
          <section>
            <SectionHeading
              actions={
                <Link href={`/transactions?from=${range.from}&to=${range.to}&type=expense,refund`} className="text-[12.5px] text-ink-2 hover:text-ink">
                  View transactions
                </Link>
              }
            >
              Spending by category
            </SectionHeading>
            {byCat.isLoading ? (
              <BarsSkeleton />
            ) : rollup.length ? (
              <CategoryBars rows={rollup} from={range.from} to={range.to} />
            ) : (
              <p className="py-6 text-sm text-ink-3">No spending in this period.</p>
            )}
            <p className="mt-3 text-[12px] text-ink-3">
              Transfers, credit-card payments and excluded transactions are not counted. Refunds net against their category.
            </p>
          </section>

          <section>
            <SectionHeading>Spending & income, last 12 months</SectionHeading>
            {monthly.isLoading ? <Skeleton className="h-[240px] w-full" /> : <TrendChart data={monthly.data ?? []} />}
          </section>

          <div className="grid grid-cols-1 gap-10 xl:grid-cols-2">
            <section className="min-w-0">
              <SectionHeading
                actions={
                  <Link href="/transactions" className="text-[12.5px] text-ink-2 hover:text-ink">
                    All
                  </Link>
                }
              >
                Recent transactions
              </SectionHeading>
              <MiniTransactionList rows={recent.data} loading={recent.isLoading} />
            </section>
            <section className="min-w-0">
              <SectionHeading>Largest expenses</SectionHeading>
              <MiniTransactionList rows={largest.data} loading={largest.isLoading} empty="No expenses in this period." />
            </section>
          </div>
        </div>

        <aside className="space-y-10">
          <ReviewCard />
          <UpcomingSection />

          <section>
            <SectionHeading>Subscriptions</SectionHeading>
            <dl className="space-y-1.5 text-[13.5px]">
              <div className="flex justify-between">
                <dt className="text-ink-2">Monthly equivalent</dt>
                <dd className="tabular">{formatMoney(subs.monthly)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-2">Annual equivalent</dt>
                <dd className="tabular">{formatMoney(subs.annual, { cents: false })}</dd>
              </div>
            </dl>
            <Link href="/recurring?type=subscription" className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink">
              <Repeat className="size-3.5" /> {subs.count} active subscription{subs.count === 1 ? "" : "s"}
            </Link>
          </section>

          <BalancesSection />
        </aside>
      </div>
    </Page>
  );
}

/** Unreviewed count with a shortcut into the review queue. */
export function ReviewCard() {
  const unreviewed = useUnreviewedCount();
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <p className="text-[13px] text-ink-2">Transactions to review</p>
      <p className="tabular mt-1 font-serif text-[32px] leading-none">{unreviewed.isLoading ? "—" : (unreviewed.data ?? 0).toLocaleString()}</p>
      <p className="mt-2 text-[13px] text-ink-2">{unreviewed.data ? "remain unreviewed." : "You're all caught up."}</p>
      {unreviewed.data ? (
        <Link href="/transactions?review=unreviewed">
          <Button variant="primary" className="mt-4 w-full">
            Review transactions <ArrowRight />
          </Button>
        </Link>
      ) : null}
    </section>
  );
}

/** The next 30 days of expected bills, subscriptions and card payments. */
export function UpcomingSection() {
  const today = todayISO();
  const upcoming = useCalendarEvents(today, toISODate(addDays(new Date(), 30)));
  const upcomingList = (upcoming.events ?? []).filter((e) => e.status === "projected" || e.status === "overdue").slice(0, 7);
  return (
    <section>
      <SectionHeading
        actions={
          <Link href="/calendar?view=agenda" className="text-[12.5px] text-ink-2 hover:text-ink">
            Calendar
          </Link>
        }
      >
        Upcoming
      </SectionHeading>
      {upcoming.isLoading ? (
        <BarsSkeleton rows={4} />
      ) : upcomingList.length ? (
        <ul className="divide-y divide-line-soft">
          {upcomingList.map((e) => (
            <li key={e.key} className="flex items-center gap-3 py-2">
              <span className="tabular w-12 shrink-0 text-[12.5px] text-ink-3">{formatShortDate(e.date)}</span>
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: EVENT_TYPE_COLORS[e.eventType] }} />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{e.title}</span>
              <span className={cn("tabular text-[13.5px]", e.status === "overdue" ? "text-brick" : "text-ink")}>
                {e.approximate ? "~" : ""}
                {formatMoney(e.amount, { cents: e.amount < 100 })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-3">
          No recurring bills in the next 30 days.{" "}
          <Link href="/recurring" className="text-accent hover:underline">
            Add one
          </Link>
        </p>
      )}
    </section>
  );
}

/** Active account balances totalled by account type. */
export function BalancesSection() {
  const { data: accounts } = useAccounts();
  const byType = useMemo(() => {
    const m = new Map<AccountType, number>();
    (accounts ?? [])
      .filter((a) => a.active)
      .forEach((a) => m.set(a.account_type as AccountType, (m.get(a.account_type as AccountType) ?? 0) + a.current_balance));
    return m;
  }, [accounts]);
  return (
    <section>
      <SectionHeading
        actions={
          <Link href="/accounts" className="text-[12.5px] text-ink-2 hover:text-ink">
            Accounts
          </Link>
        }
      >
        Balances
      </SectionHeading>
      <dl className="space-y-1.5 text-[13.5px]">
        {[...byType.entries()].map(([type, total]) => (
          <div key={type} className="flex justify-between">
            <dt className="text-ink-2">{ACCOUNT_TYPES[type]}</dt>
            <dd className="tabular">
              {isLiability(type) && total ? "-" : ""}
              {formatMoney(total, { cents: false })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Figure({
  label,
  value,
  loading,
  signed,
  strong,
}: {
  label: string;
  value: number | undefined;
  loading?: boolean;
  signed?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="border-line px-1 py-4 not-last:border-r sm:px-4 [&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0 lg:[&:nth-child(3n)]:border-r lg:[&:nth-child(6n)]:border-r-0">
      <dt className="text-[12px] text-ink-2">{label}</dt>
      <dd className={cn("tabular mt-1 font-serif leading-none", strong ? "text-[26px]" : "text-[22px]")}>
        {loading || value === undefined ? (
          <Skeleton className="h-6 w-24" />
        ) : signed ? (
          formatSigned(value, { cents: false })
        ) : (
          formatMoney(value, { cents: false })
        )}
      </dd>
    </div>
  );
}

export function BarsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5" style={{ width: `${70 - i * 9}%` }} />
        </div>
      ))}
    </div>
  );
}
