"use client";

import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/money";
import { monthLabel, OTHER_COLOR, type Area } from "@/lib/reports";

const GRID = "#e9e5dd";
const AXIS = "#dedad2";
const TICK = { fill: "#a39e97", fontSize: 11 };
const SURFACE = "#fbfaf7";
const money0 = (v: number) => formatMoney(v, { cents: false });
const kTick = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`);
const pct = (v: number, total: number) => (total > 0 ? `${Math.round((v / total) * 100)}%` : "");

function TooltipBox({ title, rows }: { title: string; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] shadow-[0_6px_24px_-8px_rgba(60,50,40,0.2)]">
      <p className="mb-1 font-medium text-ink">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="tabular flex items-center justify-between gap-6 text-ink-2">
          <span className="flex items-center gap-1.5">
            {r.color ? <span className="size-2.5 rounded-[2px]" style={{ background: r.color }} /> : null}
            {r.label}
          </span>
          <span className="text-ink">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

/** Pie slices: the areas that have their own color, then everything else as one "Other" slice. */
export function pieSlices(areas: Area[]) {
  const own = areas.filter((a) => a.color !== OTHER_COLOR);
  const rest = areas.filter((a) => a.color === OTHER_COLOR);
  const restSum = rest.reduce((s, a) => s + a.amount, 0);
  const slices = own.map((a) => ({ id: a.id, name: a.name, value: a.amount, color: a.color }));
  if (rest.length === 1) slices.push({ id: rest[0].id, name: rest[0].name, value: rest[0].amount, color: OTHER_COLOR });
  else if (restSum > 0) slices.push({ id: "__other", name: `Other (${rest.length} areas)`, value: restSum, color: OTHER_COLOR });
  return slices.sort((a, b) => b.value - a.value);
}

/** Spending share by area, with a legend that carries every name and value. */
export function SpendingPie({ areas }: { areas: Area[] }) {
  const slices = pieSlices(areas);
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[240px_1fr]">
      <div className="relative mx-auto h-[240px] w-[240px]" role="img" aria-label="Share of spending by area">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={68}
              outerRadius={112}
              paddingAngle={slices.length > 1 ? 1 : 0}
              stroke={SURFACE}
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.id} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const s = payload[0].payload as (typeof slices)[number];
                return (
                  <TooltipBox
                    title={s.name}
                    rows={[
                      { label: "Spent", value: money0(s.value), color: s.color },
                      { label: "Share", value: pct(s.value, total) },
                    ]}
                  />
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11.5px] text-ink-3">Spent</span>
          <span className="tabular font-serif text-[20px] text-ink">{money0(total)}</span>
        </div>
      </div>
      <ul className="space-y-1.5 text-[13px]">
        {slices.map((s) => (
          <li key={s.id} className="grid grid-cols-[12px_1fr_auto_40px] items-center gap-2">
            <span className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
            <span className="truncate text-ink">{s.name}</span>
            <span className="tabular text-ink">{money0(s.value)}</span>
            <span className="tabular text-right text-[12px] text-ink-3">{pct(s.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ranked horizontal bars (categories, merchants, accounts). */
export function RankedBars({
  rows,
  limit = 12,
  countLabel = "transactions",
}: {
  rows: { id: string; name: string; amount: number; count?: number; color?: string; detail?: string }[];
  limit?: number;
  countLabel?: string;
}) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const max = rows[0]?.amount || 1;
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  if (!rows.length) return <p className="py-4 text-sm text-ink-3">Nothing in this period.</p>;
  return (
    <div>
      <ul className="space-y-1">
        {shown.map((r) => (
          <li
            key={r.id}
            className="grid grid-cols-[minmax(0,150px)_1fr_auto] items-center gap-3 py-0.5 sm:grid-cols-[minmax(0,200px)_1fr_auto]"
            title={`${r.name}: ${formatMoney(r.amount)}${r.count ? ` · ${r.count} ${countLabel}` : ""}`}
          >
            <span className="min-w-0 truncate text-[13px] text-ink">
              {r.name}
              {r.detail ? <span className="text-ink-3"> · {r.detail}</span> : null}
            </span>
            <span className="block h-3">
              <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(1, (r.amount / max) * 100)}%`, background: r.color ?? "#C96442" }} />
            </span>
            <span className="tabular w-[104px] text-right text-[13px] text-ink">
              {money0(r.amount)}
              <span className="ml-1.5 text-[11.5px] text-ink-3">{pct(r.amount, total)}</span>
            </span>
          </li>
        ))}
      </ul>
      {rest.length ? (
        <p className="mt-2 text-[12px] text-ink-3">
          {rest.length} more, {money0(rest.reduce((s, r) => s + r.amount, 0))} in all. The CSV has every row.
        </p>
      ) : null}
    </div>
  );
}

/** Monthly spending stacked by area (the largest six; the rest as Other). */
export function AreaTrend({ areas, rows }: { areas: Area[]; rows: Record<string, number | string>[] }) {
  const top = areas.filter((a) => a.color !== OTHER_COLOR).slice(0, 6);
  const others = areas.filter((a) => !top.includes(a));
  const data = rows.map((r) => {
    const out: Record<string, number | string> = { month: r.month, label: monthLabel(String(r.month)) };
    for (const a of top) out[a.id] = r[a.id] ?? 0;
    out.__other = others.reduce((s, a) => s + Number(r[a.id] ?? 0), 0);
    return out;
  });
  const series = [
    ...top.map((a) => ({ id: a.id, name: a.name, color: a.color })),
    ...(others.length ? [{ id: "__other", name: "Other", color: OTHER_COLOR }] : []),
  ];
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-hidden>
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px]" style={{ background: s.color }} /> {s.name}
          </li>
        ))}
      </ul>
      <div className="h-[260px]" role="img" aria-label="Monthly spending by area">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barCategoryGap="24%" margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: AXIS }} tick={{ fill: "#77716b", fontSize: 11.5 }} />
            <YAxis width={52} tickLine={false} axisLine={false} tick={TICK} tickFormatter={kTick} />
            <Tooltip
              cursor={{ fill: "rgba(44,41,38,0.04)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Record<string, number | string>;
                const total = series.reduce((s, x) => s + Number(r[x.id] ?? 0), 0);
                return (
                  <TooltipBox
                    title={monthLabel(String(r.month), true)}
                    rows={[
                      ...series
                        .filter((s) => Number(r[s.id] ?? 0) > 0)
                        .reverse()
                        .map((s) => ({ label: s.name, value: money0(Number(r[s.id])), color: s.color })),
                      { label: "Total", value: money0(total) },
                    ]}
                  />
                );
              }}
            />
            {series.map((s, i) => (
              <Bar
                key={s.id}
                dataKey={s.id}
                stackId="a"
                fill={s.color}
                stroke={SURFACE}
                strokeWidth={1}
                maxBarSize={34}
                radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Everyday purchases by day of the week. */
export function WeekdayBars({ rows }: { rows: { day: string; amount: number; count: number }[] }) {
  return (
    <div className="h-[200px]" role="img" aria-label="Spending by day of the week">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} barCategoryGap="30%" margin={{ top: 16, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="day" tickLine={false} axisLine={{ stroke: AXIS }} tick={{ fill: "#77716b", fontSize: 11.5 }} />
          <YAxis width={52} tickLine={false} axisLine={false} tick={TICK} tickFormatter={kTick} />
          <Tooltip
            cursor={{ fill: "rgba(44,41,38,0.04)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as { day: string; amount: number; count: number };
              return (
                <TooltipBox
                  title={r.day}
                  rows={[
                    { label: "Spent", value: money0(r.amount) },
                    { label: "Purchases", value: r.count.toLocaleString() },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="amount" fill="#C96442" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
