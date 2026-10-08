"use client";

import { ArrowDownUp, ArrowLeftRight, Check, Circle, Download, Eye, EyeOff, Plus, Search, Tag as TagIcon, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AddTransactionDialog } from "@/components/forms/transaction-form";
import { CategoryPicker } from "@/components/transactions/category-picker";
import { SyncControl } from "@/components/shared/sync-control";
import { FilterPopover } from "@/components/transactions/filter-popover";
import { TagPicker } from "@/components/transactions/tag-picker";
import { TransactionDetail } from "@/components/transactions/transaction-detail";
import { TransactionRow } from "@/components/transactions/transaction-row";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { dateGroupLabel } from "@/lib/dates";
import type { LedgerTransaction } from "@/lib/domain";
import { reportError } from "@/lib/errors";
import { exportTransactions } from "@/lib/export";
import {
  DEFAULT_FILTERS,
  SORT_OPTIONS,
  UNCATEGORIZED,
  activeFilterCount,
  filtersToParams,
  parseFilters,
  type ReviewFilter,
  type TransactionFilters,
} from "@/lib/filters";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { formatMoney } from "@/lib/money";
import { useAccountIndex, useCategoryIndex, useTagIndex } from "@/lib/queries/reference";
import { useBulkAddTag, useBulkUpdate, useDeleteTransactions, useLinkTransfer, useTransactionList, useUpdateTransaction } from "@/lib/queries/transactions";

function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || Boolean(t.closest("[role=dialog],[role=menu],[cmdk-root]"));
}

export function TransactionsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const paramsKey = params.toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(paramsKey)), [paramsKey]);
  const selectedId = params.get("id");

  const cats = useCategoryIndex();
  const accounts = useAccountIndex();
  const tags = useTagIndex();
  const isMobile = useMediaQuery("(max-width: 767px)");

  const list = useTransactionList(filters, cats, !cats.isLoading);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? [], [list.data]);
  const total = list.data?.pages[0]?.count ?? null;

  const update = useUpdateTransaction();
  const bulk = useBulkUpdate();
  const bulkTag = useBulkAddTag();
  const del = useDeleteTransactions();
  const link = useLinkTransfer();
  const confirm = useConfirm();

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const [exporting, setExporting] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const sentinel = useRef<HTMLDivElement>(null);

  // ---- URL state ---------------------------------------------------------
  const setFilters = useCallback(
    (f: TransactionFilters) => {
      const sp = filtersToParams(f, new URLSearchParams(window.location.search));
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
      setChecked(new Set());
    },
    [pathname, router],
  );

  const select = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(window.location.search);
      if (id) sp.set("id", id);
      else sp.delete("id");
      window.history.replaceState(null, "", `${pathname}?${sp.toString()}`);
    },
    [pathname],
  );

  // Debounced search → URL
  useEffect(() => {
    if (searchDraft === filters.q) return;
    const t = setTimeout(() => setFilters({ ...filters, q: searchDraft }), 250);
    return () => clearTimeout(t);
  }, [searchDraft, filters, setFilters]);

  // ---- Infinite scroll ---------------------------------------------------
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage();
      },
      { root: scrollRef.current, rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, rows.length]);

  // Keep the selected row in view when moving with the keyboard.
  useEffect(() => {
    if (selectedId) rowEls.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // ---- Review workflow ---------------------------------------------------
  const advanceFrom = useCallback(
    (id: string) => {
      const idx = rows.findIndex((r) => r.id === id);
      const after = rows.slice(idx + 1);
      const next = after.find((r) => r.review_status === "unreviewed") ?? after[0];
      if (next) select(next.id);
      else if (hasNextPage) fetchNextPage();
    },
    [rows, select, hasNextPage, fetchNextPage],
  );

  const toggleReview = useCallback(
    (t: LedgerTransaction) => {
      const next = t.review_status === "reviewed" ? "unreviewed" : "reviewed";
      update.mutate({ id: t.id, patch: { review_status: next } });
      if (next === "reviewed" && !isMobile) advanceFrom(t.id);
    },
    [update, advanceFrom, isMobile],
  );

  const toggleTransfer = useCallback(
    (t: LedgerTransaction) => {
      const isTransfer = t.transaction_type === "transfer" || t.transaction_type === "credit_card_payment";
      const acct = accounts.get(t.account_id);
      const type = isTransfer
        ? t.amount > 0
          ? "income"
          : "expense"
        : acct?.account_type === "credit_card" && t.amount > 0
          ? "credit_card_payment"
          : "transfer";
      update.mutate({ id: t.id, patch: { transaction_type: type } });
      toast.success(isTransfer ? `Marked as ${type}` : "Marked as transfer — excluded from spending");
    },
    [accounts, update],
  );

  const { mutate: updateTxn } = update;
  const changeCategory = useCallback((id: string, categoryId: string | null) => updateTxn({ id, patch: { category_id: categoryId } }), [updateTxn]);

  // ---- Keyboard shortcuts -----------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const idx = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
      const current = idx >= 0 ? rows[idx] : undefined;
      switch (e.key) {
        case "ArrowDown":
        case "j": {
          e.preventDefault();
          const next = rows[Math.min(rows.length - 1, idx + 1)];
          if (next) select(next.id);
          if (idx >= rows.length - 5 && hasNextPage) fetchNextPage();
          break;
        }
        case "ArrowUp":
        case "k": {
          e.preventDefault();
          const prev = rows[Math.max(0, idx - 1)];
          if (prev) select(prev.id);
          break;
        }
        case "r":
          if (current) toggleReview(current);
          break;
        case "c":
          if (current) {
            e.preventDefault();
            setCategoryOpen(true);
          }
          break;
        case "t":
          if (current) toggleTransfer(current);
          break;
        case "x":
          if (current) setChecked((s) => toggleSet(s, current.id, !s.has(current.id)));
          break;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case "Escape":
          if (checked.size) setChecked(new Set());
          else if (selectedId) select(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selectedId, select, toggleReview, toggleTransfer, hasNextPage, fetchNextPage, checked.size]);

  // ---- Selection ---------------------------------------------------------
  const onCheck = useCallback(
    (id: string, on: boolean, shift: boolean) => {
      setChecked((prev) => {
        if (shift && anchor) {
          const a = rows.findIndex((r) => r.id === anchor);
          const b = rows.findIndex((r) => r.id === id);
          if (a >= 0 && b >= 0) {
            const next = new Set(prev);
            rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((r) => (on ? next.add(r.id) : next.delete(r.id)));
            return next;
          }
        }
        return toggleSet(prev, id, on);
      });
      setAnchor(id);
    },
    [anchor, rows],
  );

  const checkedIds = [...checked];
  const allChecked = rows.length > 0 && checked.size === rows.length;

  const bulkDelete = async () => {
    const ok = await confirm({
      title: `Delete ${checked.size} transaction${checked.size === 1 ? "" : "s"}?`,
      body: "This permanently removes them, including splits and tags. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    del.mutate(checkedIds, {
      onSuccess: () => {
        if (selectedId && checked.has(selectedId)) select(null);
        setChecked(new Set());
      },
    });
  };

  const bulkTransfer = () => {
    const picked = rows.filter((r) => checked.has(r.id));
    if (picked.length === 2 && picked[0].amount === -picked[1].amount && picked[0].account_id !== picked[1].account_id) {
      const isCard = picked.some((p) => accounts.get(p.account_id)?.account_type === "credit_card");
      link.mutate({ ids: checkedIds, type: isCard ? "credit_card_payment" : "transfer" }, { onSuccess: () => setChecked(new Set()) });
    } else {
      bulk.mutate({ ids: checkedIds, patch: { transaction_type: "transfer" } }, { onSuccess: () => setChecked(new Set()) });
    }
  };

  const doExport = async () => {
    setExporting(0);
    try {
      const n = await exportTransactions(filters, cats, accounts, tags, setExporting);
      toast.success(`Exported ${n.toLocaleString()} transactions`);
    } catch (e) {
      reportError(e, "Could not export transactions.");
    } finally {
      setExporting(null);
    }
  };

  // ---- Grouping ----------------------------------------------------------
  const dateSorted = filters.sort === "newest" || filters.sort === "oldest";
  const groups = useMemo(() => {
    if (!dateSorted) return [{ key: "all", label: SORT_OPTIONS.find((o) => o.value === filters.sort)?.label ?? "", rows }];
    const out: { key: string; label: string; rows: LedgerTransaction[] }[] = [];
    const now = new Date();
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.key === r.transaction_date) last.rows.push(r);
      else out.push({ key: r.transaction_date, label: dateGroupLabel(r.transaction_date, now), rows: [r] });
    }
    return out;
  }, [rows, dateSorted, filters.sort]);

  const filterCount = activeFilterCount(filters);
  const hasAnyFilter = filterCount > 0 || filters.q || filters.review !== "all";
  const showDetail = Boolean(selectedId);

  return (
    <div className="relative flex h-full">
      {/* ------------------------------ List pane ------------------------------ */}
      <section className={cn("flex min-w-0 flex-1 flex-col", showDetail && isMobile && "hidden")} aria-label="Transactions">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 sm:px-5">
          <Checkbox
            checked={allChecked}
            indeterminate={checked.size > 0 && !allChecked}
            label="Select all loaded transactions"
            onChange={(on) => setChecked(on ? new Set(rows.map((r) => r.id)) : new Set())}
          />
          <h1 className="mr-auto ml-1 hidden font-serif text-[21px] text-ink sm:block">Transactions</h1>
          <div className="relative min-w-0 flex-1 sm:max-w-[240px] sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" />
            <input
              ref={searchRef}
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLInputElement).blur()}
              placeholder="Search"
              aria-label="Search transactions (/)"
              className="h-8 w-full rounded-md border border-line bg-surface pr-2 pl-8 text-sm placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 focus:outline-none"
            />
          </div>
          <SyncControl compact />
          <FilterPopover filters={filters} onChange={setFilters} />
          <Menu>
            <MenuTrigger asChild>
              <Button aria-label="Sort">
                <ArrowDownUp /> <span className="hidden lg:inline">Sort</span>
              </Button>
            </MenuTrigger>
            <MenuContent>
              {SORT_OPTIONS.map((o) => (
                <MenuItem key={o.value} onSelect={() => setFilters({ ...filters, sort: o.value })}>
                  <span className="w-4">{filters.sort === o.value ? <Check className="!text-accent" /> : null}</span>
                  {o.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <IconButton label="Add transaction" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus />
          </IconButton>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="Import or export" variant="secondary">
                <Download />
              </IconButton>
            </MenuTrigger>
            <MenuContent>
              <MenuItem asChild>
                <Link href="/settings/import">
                  <Upload /> Import CSV…
                </Link>
              </MenuItem>
              <MenuItem onSelect={doExport} disabled={exporting !== null}>
                <Download /> {exporting !== null ? `Exporting… ${exporting.toLocaleString()}` : "Export current view as CSV"}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>

        {checked.size > 0 ? (
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-accent-soft/60 px-4 py-1.5 sm:px-5">
            <span className="mr-1 text-sm font-medium text-ink">{checked.size} selected</span>
            <Button size="sm" onClick={() => bulk.mutate({ ids: checkedIds, patch: { review_status: "reviewed" } })}>
              <Check /> Mark reviewed
            </Button>
            <Button size="sm" variant="quiet" onClick={() => bulk.mutate({ ids: checkedIds, patch: { review_status: "unreviewed" } })}>
              <Circle /> Unreviewed
            </Button>
            <CategoryPicker
              value={undefined}
              open={bulkCategoryOpen}
              onOpenChange={setBulkCategoryOpen}
              onChange={(id) => bulk.mutate({ ids: checkedIds, patch: { category_id: id } })}
            >
              <Button size="sm">Change category</Button>
            </CategoryPicker>
            <Button
              size="sm"
              title="Leave these out of spending, income and reports"
              onClick={() =>
                bulk.mutate(
                  { ids: checkedIds, patch: { excluded: true }, silent: true },
                  { onSuccess: (n) => toast.success(`Excluded ${n} transaction${n === 1 ? "" : "s"} from totals`) },
                )
              }
            >
              <EyeOff /> Exclude
            </Button>
            <Button
              size="sm"
              variant="quiet"
              title="Count these in spending, income and reports again"
              onClick={() =>
                bulk.mutate(
                  { ids: checkedIds, patch: { excluded: false }, silent: true },
                  { onSuccess: (n) => toast.success(`${n} transaction${n === 1 ? "" : "s"} counted in totals again`) },
                )
              }
            >
              <Eye /> Include
            </Button>
            <TagPicker selected={[]} closeOnPick onToggle={(tagId) => bulkTag.mutate({ ids: checkedIds, tagId })}>
              <Button size="sm">
                <TagIcon /> Add tag
              </Button>
            </TagPicker>
            <Button size="sm" onClick={bulkTransfer} title="Two opposite legs are linked as one transfer">
              <ArrowLeftRight /> Mark transfer
            </Button>
            <Button size="sm" variant="danger" onClick={bulkDelete}>
              <Trash2 /> Delete
            </Button>
            <IconButton label="Clear selection" size="sm" variant="quiet" className="ml-auto" onClick={() => setChecked(new Set())}>
              <X />
            </IconButton>
          </div>
        ) : (
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-line-soft px-4 py-1.5 sm:px-5">
            <Segmented<ReviewFilter>
              size="sm"
              ariaLabel="Review status"
              value={filters.review}
              onChange={(v) => setFilters({ ...filters, review: v })}
              options={[
                { value: "all", label: "All" },
                { value: "unreviewed", label: "To review" },
                { value: "reviewed", label: "Reviewed" },
              ]}
            />
            <ActiveFilterChips
              filters={filters}
              onChange={(f) => {
                if (f.q !== filters.q) setSearchDraft(f.q);
                setFilters(f);
              }}
            />
            <span className="tabular ml-auto text-[12.5px] text-ink-3">
              {total !== null ? `${total.toLocaleString()} transaction${total === 1 ? "" : "s"}` : ""}
            </span>
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="grid" aria-busy={list.isFetching}>
          {list.isLoading || cats.isLoading ? (
            <ListSkeleton />
          ) : list.isError ? (
            <EmptyState
              title="Could not load transactions."
              body="Check your connection and try again."
              action={<Button onClick={() => list.refetch()}>Retry</Button>}
            />
          ) : rows.length === 0 ? (
            hasAnyFilter ? (
              <EmptyState
                title="No transactions match these filters."
                action={
                  <Button
                    onClick={() => {
                      setSearchDraft("");
                      setFilters(DEFAULT_FILTERS);
                    }}
                  >
                    Clear all filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No transactions yet."
                body="Import a CSV export from your bank or finance app, or add a transaction by hand."
                action={
                  <div className="flex gap-2">
                    <Link href="/settings/import">
                      <Button variant="primary">
                        <Upload /> Import CSV
                      </Button>
                    </Link>
                    <Button onClick={() => setAddOpen(true)}>
                      <Plus /> Add transaction
                    </Button>
                  </div>
                }
              />
            )
          ) : (
            <>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <div className="sticky top-0 z-10 flex h-9 items-center border-y border-[#c9c3b8] bg-sidebar/95 px-5 backdrop-blur-[2px] sm:pl-12">
                    <span className="text-[12px] font-bold tracking-[0.08em] text-ink uppercase">{g.label}</span>
                    {dateSorted ? <DayTotal rows={g.rows} /> : null}
                  </div>
                  {g.rows.map((r) => (
                    <TransactionRow
                      key={r.id}
                      txn={r}
                      account={accounts.get(r.account_id)}
                      category={r.category_id ? cats.byId.get(r.category_id) : undefined}
                      selected={r.id === selectedId}
                      checked={checked.has(r.id)}
                      onSelect={select}
                      onCheck={onCheck}
                      showDate={!dateSorted}
                      onCategoryChange={changeCategory}
                      rowRef={(el) => {
                        if (el) rowEls.current.set(r.id, el);
                        else rowEls.current.delete(r.id);
                      }}
                    />
                  ))}
                </Fragment>
              ))}
              <div ref={sentinel} className="h-px" />
              {isFetchingNextPage ? <ListSkeleton rows={3} /> : null}
              {!hasNextPage && rows.length > 20 ? <p className="py-6 text-center text-[12px] text-ink-3">End of ledger</p> : null}
            </>
          )}
        </div>
      </section>

      {/* ------------------------------ Detail pane ------------------------------ */}
      {showDetail ? (
        <aside
          aria-label="Transaction details"
          className={cn(
            "bg-paper",
            isMobile
              ? "absolute inset-0 z-20"
              : "absolute inset-y-0 right-0 z-20 w-[min(460px,100%)] border-l border-line shadow-[-12px_0_32px_-16px_rgba(60,50,40,0.25)] xl:static xl:w-[440px] xl:shrink-0 xl:shadow-none 2xl:w-[500px]",
          )}
        >
          <TransactionDetail
            id={selectedId!}
            onClose={() => select(null)}
            onToggleReview={toggleReview}
            onMarkTransfer={toggleTransfer}
            onDeleted={(id) => advanceFrom(id)}
            categoryOpen={categoryOpen}
            setCategoryOpen={setCategoryOpen}
            showBack={isMobile}
          />
        </aside>
      ) : null}

      <AddTransactionDialog open={addOpen} onOpenChange={setAddOpen} defaultAccountId={filters.accounts[0]} onCreated={(t) => select(t.id)} />
    </div>
  );
}

function toggleSet(s: Set<string>, id: string, on: boolean) {
  const next = new Set(s);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

function DayTotal({ rows }: { rows: LedgerTransaction[] }) {
  const out = rows.reduce(
    (s, r) =>
      r.amount < 0 && r.transaction_type !== "transfer" && r.transaction_type !== "credit_card_payment" && !r.excluded ? s + Math.round(-r.amount * 100) : s,
    0,
  );
  if (!out) return null;
  return <span className="tabular ml-auto pr-[34px] text-[12px] font-semibold text-ink-2">{formatMoney(out / 100)}</span>;
}

function ListSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 border-b border-line-soft px-5">
          <Skeleton className="size-4" />
          <div className="flex-1">
            <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 37) % 35)}%` }} />
          </div>
          <Skeleton className="hidden h-5 w-28 rounded-full sm:block" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function ActiveFilterChips({ filters, onChange }: { filters: TransactionFilters; onChange: (f: TransactionFilters) => void }) {
  const accounts = useAccountIndex();
  const cats = useCategoryIndex();
  const tags = useTagIndex();
  const chips: { key: string; label: string; clear: Partial<TransactionFilters> }[] = [];
  if (filters.q) chips.push({ key: "q", label: `“${filters.q}”`, clear: { q: "" } });
  if (filters.accounts.length)
    chips.push({
      key: "acct",
      label: filters.accounts.length === 1 ? (accounts.get(filters.accounts[0])?.name ?? "1 account") : `${filters.accounts.length} accounts`,
      clear: { accounts: [] },
    });
  if (filters.categories.length)
    chips.push({
      key: "cat",
      label:
        filters.categories.length === 1
          ? filters.categories[0] === UNCATEGORIZED
            ? "Uncategorized"
            : (cats.byId.get(filters.categories[0])?.name ?? "1 category")
          : `${filters.categories.length} categories`,
      clear: { categories: [] },
    });
  if (filters.types.length) chips.push({ key: "type", label: filters.types.map((t) => t.replace(/_/g, " ")).join(", "), clear: { types: [] } });
  if (filters.tags.length) chips.push({ key: "tag", label: filters.tags.map((t) => `#${tags.get(t)?.name ?? "tag"}`).join(" "), clear: { tags: [] } });
  if (filters.from || filters.to) chips.push({ key: "date", label: `${filters.from || "…"} → ${filters.to || "…"}`, clear: { from: "", to: "" } });
  if (filters.min || filters.max)
    chips.push({ key: "amt", label: `$${filters.min || "0"}–${filters.max ? `$${filters.max}` : "∞"}`, clear: { min: "", max: "" } });
  if (filters.status) chips.push({ key: "status", label: filters.status === "posted" ? "Cleared" : "Pending", clear: { status: "" } });
  if (filters.recurring) chips.push({ key: "rec", label: filters.recurring === "yes" ? "Recurring" : "Not recurring", clear: { recurring: "" } });
  if (filters.excluded) chips.push({ key: "exc", label: filters.excluded === "yes" ? "Excluded" : "Not excluded", clear: { excluded: "" } });

  return (
    <>
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex h-6 max-w-[220px] items-center gap-1 rounded-full border border-line bg-surface pr-1 pl-2.5 text-[12px] text-ink-2"
        >
          <span className="truncate capitalize">{c.label}</span>
          <button
            type="button"
            aria-label={`Remove filter ${c.label}`}
            onClick={() => onChange({ ...filters, ...c.clear })}
            className="rounded-full p-0.5 hover:bg-hover hover:text-ink"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </>
  );
}
