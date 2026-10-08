"use client";

import { Command } from "cmdk";
import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CategoryIcon } from "@/components/ui/category-icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import type { Category } from "@/lib/domain";
import { useCategoryIndex } from "@/lib/queries/reference";

/** What to call an uncategorized transaction whose type already says what it is. */
const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  transfer: { label: "Transfer", color: "#6B7F99" },
  credit_card_payment: { label: "Card payment", color: "#6B7F99" },
  income: { label: "Income", color: "#5F8259" },
};

export function uncategorizedLabel(transactionType?: string | null): string {
  return (transactionType && TYPE_LABELS[transactionType]?.label) || "Uncategorized";
}

/** Tinted, small-caps category label used on ledger rows and in pickers. */
export function CategoryPill({
  category,
  className,
  muted,
  transactionType,
}: {
  category: Category | undefined | null;
  className?: string;
  muted?: boolean;
  /** When there's no category, transfers / card payments / income show their type instead of "Uncategorized". */
  transactionType?: string | null;
}) {
  const typeLabel = !category && transactionType ? TYPE_LABELS[transactionType] : undefined;
  if (typeLabel) {
    return (
      <span
        className={cn(
          "inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold tracking-[0.04em] uppercase",
          muted && "opacity-70",
          className,
        )}
        style={{ borderColor: `${typeLabel.color}55`, color: shade(typeLabel.color) }}
        title={`${typeLabel.label} — no category needed`}
      >
        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: typeLabel.color }} />
        <span className="truncate">{typeLabel.label}</span>
      </span>
    );
  }
  if (!category) {
    return (
      <span
        className={cn(
          "inline-flex h-[22px] max-w-full items-center rounded-full border border-dashed border-[#cfcac0] px-2 text-[11px] font-medium tracking-[0.04em] text-ink-3 uppercase",
          className,
        )}
      >
        Uncategorized
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold tracking-[0.04em] uppercase",
        muted && "opacity-70",
        className,
      )}
      style={{ backgroundColor: `${category.color}1c`, color: shade(category.color) }}
      title={category.name}
    >
      {category.icon ? (
        <CategoryIcon name={category.icon} className="size-3 shrink-0" />
      ) : (
        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: category.color }} />
      )}
      <span className="truncate">{category.name}</span>
    </span>
  );
}

/** Darken a swatch so small text stays legible on its own tint. */
function shade(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const f = 0.72;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

export function CategoryPicker({
  value,
  onChange,
  children,
  open: openProp,
  onOpenChange,
  allowNone = true,
  includeInactive = false,
  align = "start",
}: {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  allowNone?: boolean;
  includeInactive?: boolean;
  align?: "start" | "end" | "center";
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = onOpenChange ?? setInnerOpen;
  const cats = useCategoryIndex();

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };
  const changeOpen = (o: boolean) => {
    setOpen(o);
    if (!o) setQuery("");
  };

  const visible = (c: Category) => includeInactive || c.active || c.id === value;
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  // New search results start at the top, with the best match highlighted.
  useEffect(() => {
    // After cmdk has re-selected the first item (it scrolls the old selection into view first).
    const raf = requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0 }));
    return () => cancelAnimationFrame(raf);
  }, [query]);
  // While searching, show one flat list ordered by how well each category matches.
  const ranked = useMemo(() => {
    if (!query.trim()) return [];
    return cats.all
      .filter(visible)
      .map((c) => {
        const parent = c.parent_category_id ? cats.byId.get(c.parent_category_id) : undefined;
        return { c, parent, score: Math.max(rankCategory(c.name, query), parent ? rankCategory(parent.name, query) * 0.4 : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visible only depends on value/includeInactive
  }, [query, cats, value, includeInactive]);

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[280px] p-0">
        <Command loop shouldFilter={false} className="flex max-h-[360px] flex-col">
          <div className="flex items-center gap-2 border-b border-line-soft px-3">
            <Search className="size-4 text-ink-3" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Find a category…"
              className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-3 focus-visible:outline-none"
            />
          </div>
          <Command.List ref={listRef} className="overflow-y-auto p-1">
            {query.trim() ? (
              ranked.length ? (
                ranked.map(({ c, parent }) => (
                  <PickerItem key={c.id} id={c.id} label={c.name} hint={parent?.name} selected={value === c.id} onSelect={() => pick(c.id)}>
                    <Dot c={c} />
                  </PickerItem>
                ))
              ) : allowNone && rankCategory("Uncategorized", query) ? null : (
                <p className="px-3 py-6 text-center text-sm text-ink-3">No matching category.</p>
              )
            ) : null}
            {allowNone && (!query.trim() || rankCategory("Uncategorized", query) > 0) ? (
              <PickerItem id="none" label="Uncategorized" selected={!value} onSelect={() => pick(null)}>
                <span className="size-2 rounded-full border border-dashed border-ink-3" />
              </PickerItem>
            ) : null}
            {!query.trim()
              ? cats.parents.filter(visible).map((p) => {
                  const kids = cats.childrenOf(p.id).filter(visible);
                  return (
                    <Command.Group
                      key={p.id}
                      heading={kids.length ? p.name : undefined}
                      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase"
                    >
                      <PickerItem id={p.id} label={kids.length ? `${p.name} (general)` : p.name} selected={value === p.id} onSelect={() => pick(p.id)}>
                        <Dot c={p} />
                      </PickerItem>
                      {kids.map((k) => (
                        <PickerItem key={k.id} id={k.id} label={k.name} selected={value === k.id} onSelect={() => pick(k.id)} indent>
                          <Dot c={k} />
                        </PickerItem>
                      ))}
                    </Command.Group>
                  );
                })
              : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Dot({ c }: { c: Category }) {
  return c.icon ? (
    <CategoryIcon name={c.icon} className="size-3.5" color={c.color} />
  ) : (
    <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} />
  );
}

/**
 * How well a category name matches what was typed: names that start with it first, then a word in the name,
 * then anywhere in the name. So "u" lands on Utilities and "gro" on Groceries.
 */
function rankCategory(name: string, search: string): number {
  const q = search.trim().toLowerCase();
  const n = name.toLowerCase();
  if (!q) return 1;
  if (n.startsWith(q)) return 1;
  if (n.split(/[\s&/(),-]+/).some((w) => w.startsWith(q))) return 0.8;
  if (n.includes(q)) return 0.6;
  return 0;
}

function PickerItem({
  id,
  label,
  hint,
  selected,
  onSelect,
  children,
  indent,
}: {
  id: string;
  label: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <Command.Item
      value={id}
      onSelect={onSelect}
      className={cn("flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none data-[selected=true]:bg-hover", indent && "pl-5")}
    >
      <span className="flex w-4 justify-center">{children}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 truncate text-[11.5px] text-ink-3">{hint}</span> : null}
      {selected ? <Check className="size-3.5 text-accent" /> : null}
    </Command.Item>
  );
}
