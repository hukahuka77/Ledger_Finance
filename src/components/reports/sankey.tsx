"use client";

import { useMemo, useRef, useState } from "react";
import { useElementWidth } from "@/components/reports/use-element-width";
import { formatMoney } from "@/lib/money";
import type { SankeyLink, SankeyNode } from "@/lib/reports";

const NODE_W = 12;
const GAP = 10;
const LABEL_W = 190; // room for the last column's labels
const LINK_OPACITY = 0.3;

type Placed = SankeyNode & { x: number; y: number; h: number; label: { top: number; lines: 1 | 2 } | null };
type PlacedLink = SankeyLink & { sy: number; ty: number; w: number; s: Placed; t: Placed };

/** Money-flow chart: columns of nodes sized by value, joined by bands. */
export function Sankey({ nodes, links, total, minHeight = 420 }: { nodes: SankeyNode[]; links: SankeyLink[]; total: number; minHeight?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; title: string; value: number; color: string } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => place(nodes, links, total, width, minHeight), [nodes, links, total, width, minHeight]);
  const pct = (v: number) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : "");

  const show = (e: React.MouseEvent, title: string, value: number, color: string) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setHover({ x: e.clientX - r.left, y: e.clientY - r.top, title, value, color });
  };

  return (
    <div ref={ref} className="w-full">
      <div ref={box} className="relative" onMouseLeave={() => (setHover(null), setActive(null))}>
        <svg
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label="Money flow from income sources to spending"
          className="block max-w-full overflow-visible"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          {layout.links.map((l) => {
            const x0 = l.s.x + NODE_W;
            const x1 = l.t.x;
            const xm = (x0 + x1) / 2;
            const id = `${l.source}>${l.target}`;
            const lit = active === null || active === id || active === l.source || active === l.target;
            return (
              <path
                key={id}
                d={`M${x0},${l.sy} C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty} L${x1},${l.ty + l.w} C${xm},${l.ty + l.w} ${xm},${l.sy + l.w} ${x0},${l.sy + l.w} Z`}
                fill={l.color}
                fillOpacity={lit ? (active === id ? LINK_OPACITY + 0.25 : LINK_OPACITY) : 0.08}
                onMouseMove={(e) => {
                  setActive(id);
                  show(e, `${l.s.name} → ${l.t.name}`, l.value, l.color);
                }}
              />
            );
          })}
          {layout.nodes.map((n) => (
            <rect
              key={n.id}
              x={n.x}
              y={n.y}
              width={NODE_W}
              height={n.h}
              rx={2}
              fill={n.color}
              onMouseMove={(e) => {
                setActive(n.id);
                show(e, n.name, n.value, n.color);
              }}
            />
          ))}
          {layout.nodes.map((n) => {
            if (!n.label) return null;
            const x = n.x + NODE_W + 7;
            const two = n.label.lines === 2;
            return (
              <g key={`label-${n.id}`} pointerEvents="none" style={{ paintOrder: "stroke" }} stroke="#fbfaf7" strokeWidth={3} strokeLinejoin="round">
                <text x={x} y={n.label.top + 11.5} fontSize={12.5} fontWeight={500} fill="#2c2926">
                  {truncate(n.name, n.column === layout.lastColumn ? 26 : 22)}
                  {two ? null : <tspan fill="#77716b" fontWeight={400}>{`  ${formatMoney(n.value, { cents: false })}`}</tspan>}
                </text>
                {two ? (
                  <text x={x} y={n.label.top + 26} fontSize={11.5} fill="#77716b">
                    {`${formatMoney(n.value, { cents: false })} · ${pct(n.value)}`}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {hover ? (
          <div
            className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] shadow-[0_6px_24px_-8px_rgba(60,50,40,0.25)]"
            style={{ left: Math.min(hover.x + 14, layout.width - 220), top: hover.y + 14 }}
          >
            <p className="flex items-center gap-1.5 font-medium text-ink">
              <span className="size-2.5 rounded-[2px]" style={{ background: hover.color }} />
              {hover.title}
            </p>
            <p className="tabular mt-0.5 text-ink-2">
              {formatMoney(hover.value)} · {pct(hover.value)} of {nodes.find((n) => n.id === "hub")?.name.toLowerCase() ?? "total"}
            </p>
          </div>
        ) : null}
      </div>
      <table className="sr-only">
        <caption>Money flow</caption>
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {layout.links.map((l) => (
            <tr key={`${l.source}>${l.target}`}>
              <td>{l.s.name}</td>
              <td>{l.t.name}</td>
              <td>{formatMoney(l.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Columns spread across the width; one value scale for every column so bands keep their
 * thickness end to end. Categories sit beside their group where there is room.
 */
function place(nodes: SankeyNode[], links: SankeyLink[], total: number, width: number, minHeight: number) {
  const lastColumn = Math.max(0, ...nodes.map((n) => n.column));
  const W = Math.max(520, width);
  const usable = W - LABEL_W - NODE_W;
  const xOf = (c: number) => (lastColumn ? (c / lastColumn) * usable : 0);
  const byColumn = Array.from({ length: lastColumn + 1 }, (_, c) => nodes.filter((n) => n.column === c));
  // Height: enough for the busiest column's labels.
  const busiest = Math.max(1, ...byColumn.map((c) => c.length));
  const H = Math.max(minHeight, busiest * 34);
  const k = total > 0 ? Math.min(...byColumn.filter((c) => c.length).map((c) => (H - (c.length - 1) * GAP) / Math.max(total, sum(c)))) : 0;

  const placed = new Map<string, Placed>();
  const parentOf = new Map(links.map((l) => [l.target, l.source]));
  byColumn.forEach((col, c) => {
    let y = 0;
    for (const n of col) {
      const h = Math.max(2, n.value * k);
      // Keep a category level with its group when the column above leaves room.
      const parent = c >= 3 ? placed.get(parentOf.get(n.id) ?? "") : undefined;
      if (parent && parent.y > y) y = parent.y;
      placed.set(n.id, { ...n, x: xOf(c), y, h, label: null });
      y += h + GAP;
    }
  });

  // Labels: two lines where the node is tall enough, one line otherwise, nudged down so
  // neighbours never overlap. A label that would end up too far from its node is left
  // off (the tooltip and the table still have it).
  byColumn.forEach((col) => {
    let floor = -Infinity;
    for (const n of col.map((x) => placed.get(x.id)!).sort((a, b) => a.y - b.y)) {
      const lines = n.h >= 30 ? 2 : 1;
      const lh = lines === 2 ? 28 : 15;
      const ideal = n.y + n.h / 2 - lh / 2;
      const top = Math.max(ideal, floor + 2);
      if (top - ideal > Math.max(12, n.h / 2)) continue;
      n.label = { top, lines };
      floor = top + lh;
    }
  });

  // Stack each node's bands in the order of the nodes they lead to (and come from), so none cross.
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  const ordered = links
    .map((l) => ({ ...l, s: placed.get(l.source)!, t: placed.get(l.target)! }))
    .filter((l) => l.s && l.t)
    .sort((a, b) => a.s.y - b.s.y || a.t.y - b.t.y);
  const placedLinks: PlacedLink[] = [];
  for (const l of [...ordered].sort((a, b) => a.t.y - b.t.y || a.s.y - b.s.y)) {
    const w = Math.max(1, l.value * k);
    const ty = l.t.y + (inn.get(l.target) ?? 0);
    inn.set(l.target, (inn.get(l.target) ?? 0) + w);
    placedLinks.push({ ...l, ty, sy: 0, w });
  }
  for (const l of placedLinks.sort((a, b) => a.s.y - b.s.y || a.t.y - b.t.y)) {
    l.sy = l.s.y + (out.get(l.source) ?? 0);
    out.set(l.source, (out.get(l.source) ?? 0) + l.w);
  }

  const height = Math.max(...[...placed.values()].map((n) => Math.max(n.y + n.h, n.label ? n.label.top + (n.label.lines === 2 ? 30 : 16) : 0))) + 4;
  return { nodes: [...placed.values()], links: placedLinks, width: W, height, lastColumn };
}

function sum(col: SankeyNode[]) {
  return col.reduce((s, n) => s + n.value, 0);
}
