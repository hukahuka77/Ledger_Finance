"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Download, FileDown, RotateCcw, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { Page, PageHeader } from "@/components/layout/app-shell";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { AreaTrend, pieSlices, RankedBars, SpendingPie, WeekdayBars } from "@/components/reports/charts";
import { ReportSection } from "@/components/reports/report-section";
import { Sankey } from "@/components/reports/sankey";
import { MultiList } from "@/components/transactions/filter-popover";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatListDate, formatMediumDate } from "@/lib/dates";
import { ACCOUNT_TYPES, type AccountType } from "@/lib/domain";
import { downloadCsv } from "@/lib/export";
import { formatMoney, formatSigned } from "@/lib/money";
import { qk, unwrap, useAccountIndex, useAccounts, useCategoryIndex } from "@/lib/queries/reference";
import {
  areaColors,
  buildReport,
  buildSankey,
  filterEntries,
  REPORT_PERIODS,
  reportRange,
  UNCATEGORIZED,
  type ReportEntry,
  type ReportPeriod,
  type SankeyMode,
} from "@/lib/reports";
import { getSupabase } from "@/lib/supabase/client";

const PAGE = 1000;
const MAX_ROWS = 100_000;

/** Every countable ledger line in the range (splits arrive as one line per split). */
function useReportEntries(from: string, to: string) {
  return useQuery({
    queryKey: [...qk.analytics, "report-entries", from, to],
    queryFn: async () => {
      const rows: ReportEntry[] = [];
      for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
        const page = await unwrap<ReportEntry[]>(
          getSupabase()
            .from("countable_entries")
            .select("transaction_id, account_id, transaction_date, merchant_name, amount, category_id, transaction_type")
            .gte("transaction_date", from)
            .lte("transaction_date", to)
            .order("transaction_date")
            .order("transaction_id")
            .order("split_id", { nullsFirst: true })
            .range(offset, offset + PAGE - 1),
        );
        rows.push(...page.map((r) => ({ ...r, amount: Number(r.amount) })));
        if (page.length < PAGE) break;
      }
      return rows;
    },
  });
}

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

export function ReportsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { isBusiness } = useWorkspace();
  const cats = useCategoryIndex();
  const { data: accountList } = useAccounts();
  const accounts = useAccountIndex();

  const period = (REPORT_PERIODS.some((p) => p.value === params.get("period")) ? params.get("period") : "last_3_months") as ReportPeriod;
  const range = reportRange(period, { from: params.get("from") ?? undefined, to: params.get("to") ?? undefined });
  const filters = { accountIds: list(params.get("accounts")), categoryIds: list(params.get("categories")), search: params.get("q") ?? "" };
  const flow = (["areas", "categories", "both"].includes(params.get("flow") ?? "") ? params.get("flow") : "both") as SankeyMode;

  const set = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  const entries = useReportEntries(range.from, range.to);
  const colorOf = useMemo(() => areaColors(cats.parents), [cats.parents]);
  const filtersKey = JSON.stringify(filters);
  const report = useMemo(() => {
    if (!entries.data) return null;
    const rows = filterEntries(entries.data, filters, cats);
    return buildReport(rows, range, cats, colorOf, (id) => accounts.get(id)?.name ?? "Unknown account");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filters/range are derived from the URL
  }, [entries.data, filtersKey, range.from, range.to, cats, colorOf, accounts]);
  const sankey = useMemo(() => (report ? buildSankey(report, flow) : null), [report, flow]);

  const words = isBusiness ? { income: "Revenue", spending: "Expenses", net: "Net profit" } : { income: "Income", spending: "Spending", net: "Net" };
  const periodText = `${formatMediumDate(range.from)} – ${formatMediumDate(range.to)}`;
  const stem = `${range.from}_${range.to}`;
  const activeFilters = filters.accountIds.length + filters.categoryIds.length + (filters.search ? 1 : 0);
  const filterSummary = [
    filters.accountIds.length ? `${filters.accountIds.length} account${filters.accountIds.length === 1 ? "" : "s"}` : "all accounts",
    filters.categoryIds.length ? `${filters.categoryIds.length} categor${filters.categoryIds.length === 1 ? "y" : "ies"}` : "all categories",
    filters.search ? `matching “${filters.search}”` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Filter option lists.
  const accountItems: { value: string; label: string; heading?: string }[] = [];
  (Object.keys(ACCOUNT_TYPES) as AccountType[]).forEach((type) => {
    const of = (accountList ?? []).filter((a) => a.account_type === type);
    if (!of.length) return;
    accountItems.push({ value: "", label: "", heading: ACCOUNT_TYPES[type] });
    of.forEach((a) => accountItems.push({ value: a.id, label: `${a.name}${a.last_four ? ` ··${a.last_four}` : ""}` }));
  });
  const categoryItems: { value: string; label: string; indent?: boolean }[] = [{ value: UNCATEGORIZED, label: "Uncategorized" }];
  cats.parents.forEach((p) => {
    if (p.category_type === "transfer") return;
    categoryItems.push({ value: p.id, label: p.name });
    cats.childrenOf(p.id).forEach((k) => categoryItems.push({ value: k.id, label: k.name, indent: true }));
  });

  const exportAll = () => {
    if (!entries.data) return;
    const rows = filterEntries(entries.data, filters, cats);
    downloadCsv(
      `report-transactions_${stem}.csv`,
      rows.map((e) => {
        const c = e.category_id ? cats.byId.get(e.category_id) : undefined;
        const parent = cats.parentOf(e.category_id);
        return {
          date: e.transaction_date,
          merchant: e.merchant_name ?? "",
          account: e.account_id ? (accounts.get(e.account_id)?.name ?? "") : "",
          group: parent?.name ?? c?.name ?? "Uncategorized",
          category: c?.name ?? "Uncategorized",
          type: e.transaction_type,
          amount: e.amount,
        };
      }),
    );
  };

  const loading = entries.isLoading || cats.isLoading;
  const empty = report && report.income === 0 && report.spending === 0;

  return (
    <Page wide>
      <PageHeader
        title="Reports"
        subtitle={
          <>
            {periodText} · {filterSummary}
          </>
        }
        actions={
          <Menu>
            <MenuTrigger asChild>
              <Button variant="primary" className="print:hidden" disabled={!report}>
                <FileDown /> Export <ChevronDown className="opacity-70" />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => window.print()}>
                <FileDown /> Full report as PDF
              </MenuItem>
              <MenuItem onSelect={exportAll}>
                <Download /> Transactions in this report (CSV)
              </MenuItem>
            </MenuContent>
          </Menu>
        }
      />

      {/* Filters: one row above the charts. */}
      <div className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Select aria-label="Period" className="w-44" value={period} onChange={(e) => set({ period: e.target.value, from: null, to: null })}>
          {REPORT_PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
        {period === "custom" ? (
          <>
            <Input type="date" aria-label="From" className="w-40" value={range.from} onChange={(e) => set({ from: e.target.value })} />
            <span className="text-ink-3">–</span>
            <Input type="date" aria-label="To" className="w-40" value={range.to} min={range.from} onChange={(e) => set({ to: e.target.value })} />
          </>
        ) : null}
        <FilterPicker label="Accounts" items={accountItems} selected={filters.accountIds} onChange={(v) => set({ accounts: v.join(",") || null })} />
        <FilterPicker label="Categories" items={categoryItems} selected={filters.categoryIds} onChange={(v) => set({ categories: v.join(",") || null })} />
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            aria-label="Merchant contains"
            placeholder="Merchant…"
            className="w-44 pl-8"
            defaultValue={filters.search}
            onKeyDown={(e) => e.key === "Enter" && set({ q: (e.target as HTMLInputElement).value.trim() || null })}
            onBlur={(e) => e.target.value.trim() !== filters.search && set({ q: e.target.value.trim() || null })}
          />
        </div>
        {activeFilters ? (
          <Button variant="quiet" onClick={() => set({ accounts: null, categories: null, q: null })}>
            <RotateCcw /> Clear filters
          </Button>
        ) : null}
      </div>

      {loading || !report || !sankey ? (
        <div className="space-y-6">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-[420px] w-full" />
        </div>
      ) : empty ? (
        <p className="rounded-lg border border-line bg-surface px-5 py-10 text-center text-sm text-ink-3">
          Nothing to report for {periodText}
          {activeFilters ? " with these filters" : ""}.
        </p>
      ) : (
        <div className="space-y-6">
          <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-3 lg:grid-cols-5">
            <Kpi label={words.income} value={formatMoney(report.income, { cents: false })} tone="pos" />
            <Kpi label={words.spending} value={formatMoney(report.spending, { cents: false })} />
            <Kpi label={words.net} value={formatSigned(report.net, { cents: false })} tone={report.net >= 0 ? "pos" : "neg"} />
            <Kpi label="Savings rate" value={report.savingsRate === null ? "—" : `${(report.savingsRate * 100).toFixed(1)}%`} />
            <Kpi
              label={`Avg. ${words.spending.toLowerCase()} / month`}
              value={formatMoney(report.spending / Math.max(1, report.months), { cents: false })}
              hint={`${report.transactionCount.toLocaleString()} transactions`}
            />
          </dl>

          <ReportSection
            title="Money flow"
            subtitle={`From ${words.income.toLowerCase()} to every ${flow === "areas" ? "group" : "category"}. Percentages are of ${
              report.income >= report.spending ? `total ${words.income.toLowerCase()}` : `total ${words.spending.toLowerCase()}`
            }.`}
            fileName={`money-flow_${stem}`}
            controls={
              <Segmented
                size="sm"
                ariaLabel="Detail"
                value={flow}
                onChange={(v) => set({ flow: v === "both" ? null : v })}
                options={[
                  { value: "categories", label: "Categories" },
                  { value: "areas", label: "Groups" },
                  { value: "both", label: "Both" },
                ]}
              />
            }
            csv={() => sankey.links.map((l) => ({ from: name(sankey.nodes, l.source), to: name(sankey.nodes, l.target), amount: l.value }))}
          >
            <Sankey nodes={sankey.nodes} links={sankey.links} total={sankey.total} />
          </ReportSection>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <ReportSection
              title="Where the money went"
              subtitle={`Share of ${words.spending.toLowerCase()} by group, net of refunds.`}
              fileName={`spending-by-group_${stem}`}
              csv={() => pieSlices(report.areas).map((s) => ({ group: s.name, amount: s.value }))}
            >
              <SpendingPie areas={report.areas} />
            </ReportSection>
            <ReportSection
              title={`${words.income} and ${words.spending.toLowerCase()} by month`}
              subtitle={`Average ${words.income.toLowerCase()} ${formatMoney(report.income / Math.max(1, report.months), { cents: false })} · average ${words.spending.toLowerCase()} ${formatMoney(report.spending / Math.max(1, report.months), { cents: false })} a month.`}
              fileName={`monthly-cash-flow_${stem}`}
              csv={() =>
                report.monthly.map((m) => ({
                  month: m.month.slice(0, 7),
                  [words.income.toLowerCase()]: m.income,
                  [words.spending.toLowerCase()]: m.spending,
                  net: m.income - m.spending,
                }))
              }
            >
              <TrendChart
                data={report.monthly}
                labels={{ spending: words.spending, income: words.income }}
                ariaLabel={`Monthly ${words.income.toLowerCase()} and ${words.spending.toLowerCase()}, ${periodText}`}
              />
            </ReportSection>
          </div>

          {report.months > 1 ? (
            <ReportSection
              title={`${words.spending} by group over time`}
              subtitle="The six largest groups; the rest are combined as Other."
              fileName={`spending-trend_${stem}`}
              csv={() =>
                report.monthlyByArea.map((r) => ({
                  month: String(r.month).slice(0, 7),
                  ...Object.fromEntries(report.areas.map((a) => [a.name, Number(r[a.id] ?? 0)])),
                }))
              }
            >
              <AreaTrend areas={report.areas} rows={report.monthlyByArea} />
            </ReportSection>
          ) : null}

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <ReportSection
              title="Every category, ranked"
              subtitle="Net of refunds. Bar colors match each category's group."
              fileName={`categories_${stem}`}
              csv={() => report.areas.flatMap((a) => a.children.map((c) => ({ group: a.name, category: c.name, amount: c.amount, transactions: c.count })))}
            >
              <RankedBars
                limit={15}
                rows={report.areas
                  .flatMap((a) => a.children.map((c) => ({ id: `${a.id}:${c.id}`, name: c.name, amount: c.amount, count: c.count, color: a.color })))
                  .sort((x, y) => y.amount - x.amount)}
              />
            </ReportSection>
            <ReportSection
              title="Top merchants"
              subtitle="Net of refunds."
              fileName={`merchants_${stem}`}
              csv={() => report.merchants.map((m) => ({ merchant: m.name, amount: m.amount, transactions: m.count }))}
            >
              <RankedBars limit={15} rows={report.merchants.map((m) => ({ id: m.name, name: m.name, amount: m.amount, count: m.count, color: "#4271B0" }))} />
            </ReportSection>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <ReportSection
              title="By account"
              subtitle={`Where ${words.spending.toLowerCase()} was charged, net of refunds.`}
              fileName={`accounts_${stem}`}
              csv={() => report.accounts.map((a) => ({ account: a.name, amount: a.amount, transactions: a.count }))}
            >
              <RankedBars limit={10} rows={report.accounts.map((a) => ({ ...a, color: "#5a6e8c" }))} />
            </ReportSection>
            <ReportSection
              title="By day of the week"
              subtitle="Purchases only (refunds left out)."
              fileName={`weekdays_${stem}`}
              csv={() => report.weekdays.map((w) => ({ day: w.day, amount: w.amount, purchases: w.count }))}
            >
              <WeekdayBars rows={report.weekdays} />
            </ReportSection>
          </div>

          <ReportSection
            title="Largest purchases"
            fileName={`largest_${stem}`}
            csv={() =>
              report.largest.map((e) => ({
                date: e.transaction_date,
                merchant: e.merchant_name ?? "",
                category: (e.category_id && cats.byId.get(e.category_id)?.name) || "Uncategorized",
                account: e.account_id ? (accounts.get(e.account_id)?.name ?? "") : "",
                amount: -e.amount,
              }))
            }
          >
            <ul className="divide-y divide-line-soft">
              {report.largest.map((e, i) => (
                <li key={`${e.transaction_id}-${i}`} className="grid grid-cols-[74px_1fr_auto] items-center gap-3 py-2 text-[13.5px]">
                  <span className="tabular text-[12.5px] text-ink-3">{formatListDate(e.transaction_date)}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-ink">{e.merchant_name}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {(e.category_id && cats.byId.get(e.category_id)?.name) || "Uncategorized"}
                      {e.account_id ? ` · ${accounts.get(e.account_id)?.name ?? ""}` : ""}
                    </span>
                  </span>
                  <span className="tabular text-ink">{formatMoney(-e.amount)}</span>
                </li>
              ))}
            </ul>
          </ReportSection>

          <p className="text-[12px] text-ink-3">
            Counts every transaction dated {periodText}. Transfers between your accounts, credit card payments and excluded transactions are left out, the same
            as everywhere else in the app.
          </p>
        </div>
      )}
    </Page>
  );
}

function name(nodes: { id: string; name: string }[], id: string) {
  return nodes.find((n) => n.id === id)?.name ?? id;
}

function Kpi({ label, value, tone, hint }: { label: string; value: string; tone?: "pos" | "neg"; hint?: string }) {
  return (
    <div className="border-line px-4 py-4 not-last:border-r [&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0 lg:[&:nth-child(3n)]:border-r lg:[&:nth-child(5n)]:border-r-0">
      <dt className="text-[12px] text-ink-2">{label}</dt>
      <dd className={cn("tabular mt-1 font-serif text-[22px] leading-none", tone === "pos" ? "text-sage" : tone === "neg" ? "text-brick" : "text-ink")}>
        {value}
      </dd>
      {hint ? <p className="mt-1.5 text-[11.5px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

function FilterPicker({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: { value: string; label: string; indent?: boolean; heading?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className={cn(selected.length && "border-accent/30 bg-accent-soft text-accent hover:border-accent/50 hover:bg-accent-soft")}>
          {label}
          {selected.length ? <span className="tabular text-[12px]">{selected.length}</span> : null}
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2">
        <MultiList items={items} selected={selected} onChange={onChange} className="max-h-72" />
        <div className="mt-2 flex justify-between text-[12.5px]">
          <button type="button" className="text-ink-2 hover:text-ink" onClick={() => onChange([])}>
            All {label.toLowerCase()}
          </button>
          <span className="text-ink-3">{selected.length ? `${selected.length} selected` : "None selected = all"}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
