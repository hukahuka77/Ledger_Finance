"use client";

import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fromISODate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

// Validated pair (dataviz validator, light surface): terracotta spending, blue income.
export const SPEND_COLOR = "#C96442";
export const INCOME_COLOR = "#4271B0";

type Row = { month: string; spending: number; income: number };

/** Monthly bars. `labels` renames the series (a business shows revenue and expenses). */
export function TrendChart({
  data,
  labels = { spending: "Spending", income: "Income" },
  ariaLabel,
}: {
  data: Row[];
  labels?: { spending: string; income: string };
  ariaLabel?: string;
}) {
  const rows = data.map((d) => ({ ...d, label: format(fromISODate(d.month), "MMM") }));
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-[12px] text-ink-2" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: SPEND_COLOR }} /> {labels.spending}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: INCOME_COLOR }} /> {labels.income}
        </span>
      </div>
      <div
        className="h-[220px]"
        role="img"
        aria-label={ariaLabel ?? `Monthly ${labels.spending.toLowerCase()} and ${labels.income.toLowerCase()}, last 12 months`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} barGap={2} barCategoryGap="28%" margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#e9e5dd" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "#dedad2" }} tick={{ fill: "#77716b", fontSize: 11.5 }} />
            <YAxis
              width={52}
              domain={[0, "auto"]}
              tickLine={false}
              axisLine={false}
              tick={{ fill: "#a39e97", fontSize: 11 }}
              tickFormatter={(v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
            />
            <Tooltip
              cursor={{ fill: "rgba(44,41,38,0.04)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Row;
                return (
                  <div className="rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] shadow-[0_6px_24px_-8px_rgba(60,50,40,0.2)]">
                    <p className="mb-1 font-medium text-ink">{format(fromISODate(r.month), "MMMM yyyy")}</p>
                    <p className="tabular flex justify-between gap-6 text-ink-2">
                      <span>{labels.spending}</span> <span className="text-ink">{formatMoney(r.spending, { cents: false })}</span>
                    </p>
                    <p className="tabular flex justify-between gap-6 text-ink-2">
                      <span>{labels.income}</span> <span className="text-ink">{formatMoney(r.income, { cents: false })}</span>
                    </p>
                    <p className="tabular mt-1 flex justify-between gap-6 border-t border-line-soft pt-1 text-ink-2">
                      <span>Net</span>{" "}
                      <span className="text-ink">
                        {r.income - r.spending < 0 ? "-" : ""}
                        {formatMoney(r.income - r.spending, { cents: false })}
                      </span>
                    </p>
                  </div>
                );
              }}
            />
            <Bar dataKey="spending" fill={SPEND_COLOR} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            <Bar dataKey="income" fill={INCOME_COLOR} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>
          Monthly {labels.spending.toLowerCase()} and {labels.income.toLowerCase()}
        </caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>{labels.spending}</th>
            <th>{labels.income}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <td>{r.label}</td>
              <td>{formatMoney(r.spending)}</td>
              <td>{formatMoney(r.income)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
