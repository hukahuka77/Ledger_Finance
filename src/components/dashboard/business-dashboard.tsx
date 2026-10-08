"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo } from "react";
import { BalancesSection, BarsSkeleton, DashboardHeader, Figure, ReviewCard, UpcomingSection, useDashboardPeriod } from "@/components/dashboard/dashboard-view";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { Page, SectionHeading } from "@/components/layout/app-shell";
import { MiniTransactionList } from "@/components/shared/mini-transaction-list";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { todayISO } from "@/lib/dates";
import { isLiability, type Category } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { useBusinessSummary, useLargestTransactions, useMonthlyPnl, usePnlByCategory, useRecentTransactions } from "@/lib/queries/analytics";
import { qk, unwrap, useAccounts, useCategoryIndex, type CategoryIndex } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

/** Accounts that hold the business's cash. */
const CASH_TYPES = new Set(["checking", "savings", "cash"]);

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "—");

type PnlRow = { category_id: string | null; pnl_class: string; amount: number; transaction_count: number };
type PnlLine = { id: string | null; name: string; amount: number };

/** P&L lines for one class, rolled up to top-level account groups, largest first. */
function linesFor(rows: PnlRow[], cls: string, cats: CategoryIndex): PnlLine[] {
  const byParent = new Map<string, PnlLine>();
  for (const r of rows.filter((x) => x.pnl_class === cls)) {
    const cat: Category | undefined = r.category_id ? cats.byId.get(r.category_id) : undefined;
    const parent = cat?.parent_category_id ? cats.byId.get(cat.parent_category_id) : cat;
    const key = parent?.id ?? "none";
    const line = byParent.get(key) ?? { id: parent?.id ?? null, name: parent?.name ?? "Uncategorized", amount: 0 };
    line.amount += r.amount;
    byParent.set(key, line);
  }
  return [...byParent.values()].filter((l) => Math.abs(l.amount) >= 0.005).sort((a, b) => b.amount - a.amount);
}

/** Largest sources of revenue in the period, by payer. */
function useTopRevenue(from: string, to: string) {
  return useQuery({
    queryKey: [...qk.transactions, "top-revenue", from, to],
    queryFn: async () => {
      const rows = await unwrap<{ merchant_name: string; amount: number }[]>(
        getSupabase()
          .from("transactions")
          .select("merchant_name, amount")
          .eq("transaction_type", "income")
          .eq("excluded", false)
          .gte("transaction_date", from)
          .lte("transaction_date", to)
          .limit(5000),
      );
      const totals = new Map<string, number>();
      rows.forEach((r) => totals.set(r.merchant_name, (totals.get(r.merchant_name) ?? 0) + r.amount));
      return [...totals.entries()]
        .map(([name, amount]) => ({ name, amount }))
        .filter((r) => r.amount > 0)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 6);
    },
  });
}

/** Dashboard for business workspaces: revenue, profit, margin and cash instead of net worth and spending. */
export function BusinessDashboard() {
  const periodState = useDashboardPeriod();
  const { period, range } = periodState;
  const periodWord = period === "this_month" ? "this month" : "period";
  const cats = useCategoryIndex();
  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const summary = useBusinessSummary(range.from, range.to);
  const pnl = usePnlByCategory(range.from, range.to);
  const monthly = useMonthlyPnl(todayISO(), 12);
  const recent = useRecentTransactions(8);
  const largest = useLargestTransactions(range.from, range.to);
  const topRevenue = useTopRevenue(range.from, range.to);

  const s = summary.data;
  const expenses = s ? s.cost_of_goods + s.operating_expenses : undefined;
  const net = s ? s.revenue - s.cost_of_goods - s.operating_expenses : undefined;

  const balances = useMemo(() => {
    const active = (accounts ?? []).filter((a) => a.active);
    return {
      cash: active.filter((a) => CASH_TYPES.has(a.account_type)).reduce((t, a) => t + a.current_balance, 0),
      owed: active.filter((a) => isLiability(a.account_type)).reduce((t, a) => t + a.current_balance, 0),
    };
  }, [accounts]);

  // Average monthly net over the last three complete months, and how long cash lasts if negative.
  const runway = useMemo(() => {
    const done = (monthly.data ?? []).slice(0, -1).slice(-3);
    if (!done.length) return null;
    const avg = done.reduce((t, m) => t + m.revenue - m.cost_of_goods - m.operating_expenses, 0) / done.length;
    return { avg, months: avg < 0 ? balances.cash / -avg : null };
  }, [monthly.data, balances.cash]);

  const trend = useMemo(
    () => (monthly.data ?? []).map((m) => ({ month: m.month, income: m.revenue, spending: m.cost_of_goods + m.operating_expenses })),
    [monthly.data],
  );

  if (!accountsLoading && !(accounts ?? []).length) {
    return (
      <Page>
        <EmptyState
          title="No business accounts yet."
          body="Connect the business's bank accounts and cards, or import a CSV. This page then fills in with revenue, profit, margin and cash."
          action={
            <div className="flex gap-2">
              <Link href="/settings/connections">
                <Button variant="primary">Connect a bank</Button>
              </Link>
              <Link href="/settings/import">
                <Button>Import a CSV</Button>
              </Link>
            </div>
          }
        />
      </Page>
    );
  }

  return (
    <Page wide>
      <DashboardHeader eyebrow="Business overview" {...periodState} />

      <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-3 lg:grid-cols-6">
        <Figure label={`Revenue · ${periodWord}`} value={s?.revenue} loading={summary.isLoading} />
        <Figure label={`Expenses · ${periodWord}`} value={expenses} loading={summary.isLoading} />
        <Figure label={`Net profit · ${periodWord}`} value={net} signed strong loading={summary.isLoading} />
        <PercentFigure label="Profit margin" value={s && net !== undefined ? pct(net, s.revenue) : undefined} />
        <Figure label="Cash on hand" value={balances.cash} loading={accountsLoading} />
        <Figure label="Owed on cards & loans" value={balances.owed} loading={accountsLoading} />
      </dl>

      <div className="mt-10 grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-10">
          <section>
            <SectionHeading
              actions={
                <Link href="/categories" className="text-[12.5px] text-ink-2 hover:text-ink">
                  Chart of accounts
                </Link>
              }
            >
              Profit &amp; loss
            </SectionHeading>
            {pnl.isLoading || summary.isLoading || !s ? (
              <BarsSkeleton />
            ) : (
              <ProfitAndLoss rows={pnl.data ?? []} cats={cats} summary={s} from={range.from} to={range.to} />
            )}
          </section>

          <section>
            <SectionHeading>Revenue &amp; expenses, last 12 months</SectionHeading>
            {monthly.isLoading ? <Skeleton className="h-[240px] w-full" /> : <TrendChart data={trend} labels={{ spending: "Expenses", income: "Revenue" }} />}
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

          <section>
            <SectionHeading>Cash runway</SectionHeading>
            {monthly.isLoading || accountsLoading ? (
              <BarsSkeleton rows={2} />
            ) : runway ? (
              <dl className="space-y-1.5 text-[13.5px]">
                <div className="flex justify-between">
                  <dt className="text-ink-2">Avg monthly net, last 3 months</dt>
                  <dd className={cn("tabular", runway.avg < 0 && "text-brick")}>
                    {runway.avg < 0 ? "-" : ""}
                    {formatMoney(runway.avg, { cents: false })}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-2">Runway at that rate</dt>
                  <dd className="tabular">{runway.months === null ? "Profitable" : runway.months >= 36 ? "3+ years" : `${runway.months.toFixed(1)} months`}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-ink-3">Needs a full month of history.</p>
            )}
          </section>

          <section>
            <SectionHeading>Top revenue sources</SectionHeading>
            {topRevenue.isLoading ? (
              <BarsSkeleton rows={3} />
            ) : topRevenue.data?.length ? (
              <dl className="space-y-1.5 text-[13.5px]">
                {topRevenue.data.map((r) => (
                  <div key={r.name} className="flex justify-between gap-3">
                    <dt className="min-w-0 truncate text-ink-2">{r.name}</dt>
                    <dd className="tabular shrink-0">{formatMoney(r.amount, { cents: false })}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-ink-3">No revenue in this period.</p>
            )}
          </section>

          <section>
            <SectionHeading>Owner&apos;s equity · {periodWord}</SectionHeading>
            <dl className="space-y-1.5 text-[13.5px]">
              <div className="flex justify-between">
                <dt className="text-ink-2">Contributions</dt>
                <dd className="tabular">{s ? formatMoney(s.owner_contributions, { cents: false }) : "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-2">Draws</dt>
                <dd className="tabular">{s ? formatMoney(s.owner_draws, { cents: false }) : "—"}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[12px] text-ink-3">Money you put in or took out. Not part of profit. Assign it to the Owner&apos;s Equity accounts.</p>
          </section>

          <UpcomingSection />
          <BalancesSection />
        </aside>
      </div>
    </Page>
  );
}

function PercentFigure({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="border-line px-1 py-4 not-last:border-r sm:px-4 [&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0 lg:[&:nth-child(3n)]:border-r lg:[&:nth-child(6n)]:border-r-0">
      <dt className="text-[12px] text-ink-2">{label}</dt>
      <dd className="tabular mt-1 font-serif text-[22px] leading-none">{value === undefined ? <Skeleton className="h-6 w-16" /> : value}</dd>
    </div>
  );
}

function PnlLines({ lines, revenue, from, to }: { lines: PnlLine[]; revenue: number; from: string; to: string }) {
  return lines.map((l) => (
    <tr key={l.id ?? "none"} className="border-b border-line-soft">
      <td className="py-1.5 pl-4">
        <Link
          href={`/transactions?${new URLSearchParams({ from, to, category: l.id ?? "none" }).toString()}`}
          className="text-ink-2 hover:text-ink hover:underline"
        >
          {l.name}
        </Link>
      </td>
      <td className="tabular py-1.5 text-right">{formatMoney(l.amount)}</td>
      <td className="tabular hidden w-20 py-1.5 text-right text-[12.5px] text-ink-3 sm:table-cell">{pct(l.amount, revenue)}</td>
    </tr>
  ));
}

function PnlTotal({ label, value, revenue, strong }: { label: string; value: number; revenue: number; strong?: boolean }) {
  return (
    <tr className={cn("border-b border-line", strong && "font-medium")}>
      <td className={cn("py-2", strong && "font-serif text-[16px]")}>{label}</td>
      <td className={cn("tabular py-2 text-right", strong && "font-serif text-[16px]", value < 0 && "text-brick")}>
        {value < 0 ? "-" : ""}
        {formatMoney(value)}
      </td>
      <td className="tabular hidden w-20 py-2 text-right text-[12.5px] text-ink-3 sm:table-cell">{pct(value, revenue)}</td>
    </tr>
  );
}

function PnlHeading({ label }: { label: string }) {
  return (
    <tr>
      <th colSpan={3} className="pt-4 pb-1 text-left text-[11.5px] font-bold tracking-[0.08em] text-ink-2 uppercase">
        {label}
      </th>
    </tr>
  );
}

/** A compact income statement: revenue, cost of goods, gross profit, operating expenses, net profit. */
function ProfitAndLoss({
  rows,
  cats,
  summary,
  from,
  to,
}: {
  rows: PnlRow[];
  cats: CategoryIndex;
  summary: { revenue: number; cost_of_goods: number; operating_expenses: number };
  from: string;
  to: string;
}) {
  const revenue = linesFor(rows, "income", cats);
  const cogs = linesFor(rows, "cost_of_goods", cats);
  const opex = linesFor(rows, "expense", cats);
  const gross = summary.revenue - summary.cost_of_goods;
  const net = gross - summary.operating_expenses;
  const r = summary.revenue;

  if (!revenue.length && !cogs.length && !opex.length) return <p className="py-6 text-sm text-ink-3">No revenue or expenses in this period.</p>;

  return (
    <table className="w-full text-[13.5px]">
      <thead className="sr-only">
        <tr>
          <th>Line</th>
          <th>Amount</th>
          <th>Share of revenue</th>
        </tr>
      </thead>
      <tbody>
        <PnlHeading label="Revenue" />
        <PnlLines lines={revenue} revenue={r} from={from} to={to} />
        <PnlTotal label="Total revenue" value={summary.revenue} revenue={r} />
        {cogs.length ? (
          <>
            <PnlHeading label="Cost of goods sold" />
            <PnlLines lines={cogs} revenue={r} from={from} to={to} />
            <PnlTotal label="Gross profit" value={gross} revenue={r} />
          </>
        ) : null}
        <PnlHeading label="Operating expenses" />
        <PnlLines lines={opex} revenue={r} from={from} to={to} />
        <PnlTotal label="Total operating expenses" value={summary.operating_expenses} revenue={r} />
        <PnlTotal label="Net profit" value={net} revenue={r} strong />
      </tbody>
    </table>
  );
}
