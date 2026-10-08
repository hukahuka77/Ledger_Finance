"use client";

import { ArrowDown, ArrowUp, List as ListIcon, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CategoryTransactionsPanel } from "@/components/categories/category-transactions-panel";
import { Page, PageHeader } from "@/components/layout/app-shell";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { Button, IconButton } from "@/components/ui/button";
import { CATEGORY_ICON_NAMES, CategoryIcon } from "@/components/ui/category-icon";
import { Switch } from "@/components/ui/checkbox";
import { Dialog, useConfirm } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { periodRange } from "@/lib/dates";
import {
  BUSINESS_CATEGORY_TYPE_OPTIONS,
  BUSINESS_CATEGORY_TYPES,
  BUSINESS_CLASS_HEADINGS,
  CATEGORY_TYPE_OPTIONS,
  CATEGORY_TYPES,
  SWATCHES,
  type BusinessCategoryType,
  type Category,
} from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { usePnlByCategory, useSpendingByCategory } from "@/lib/queries/analytics";
import { useCategoryIndex, useDeleteCategory, useReorderCategories, useSaveCategory, useSeedCategories } from "@/lib/queries/reference";

export function CategoriesView() {
  const { isBusiness } = useWorkspace();
  const cats = useCategoryIndex();
  const seed = useSeedCategories();
  const [showInactive, setShowInactive] = useState(true);
  const [newName, setNewName] = useState("");
  const [viewing, setViewing] = useState<Category | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const save = useSaveCategory();
  const range = periodRange("this_month");
  // Personal: this month's spending. Business: this month's activity in each account (revenue, costs, equity).
  const spend = useSpendingByCategory(range.from, range.to);
  const pnl = usePnlByCategory(range.from, range.to, isBusiness);
  const spendBy = useMemo(
    () => new Map(isBusiness ? (pnl.data ?? []).map((s) => [s.category_id, s.amount]) : (spend.data ?? []).map((s) => [s.category_id, s.amount])),
    [isBusiness, pnl.data, spend.data],
  );
  // Business: group the top-level accounts by class, in statement order.
  const sections = useMemo(() => {
    const parents = cats.parents.filter((c) => showInactive || c.active);
    if (!isBusiness) return [{ key: "all", heading: null as string | null, parents }];
    return (Object.keys(BUSINESS_CLASS_HEADINGS) as BusinessCategoryType[])
      .map((k) => ({ key: k as string, heading: BUSINESS_CLASS_HEADINGS[k] as string | null, parents: parents.filter((p) => p.category_type === k) }))
      .concat([{ key: "other", heading: "Other", parents: parents.filter((p) => !(p.category_type in BUSINESS_CLASS_HEADINGS)) }])
      .filter((g) => g.parents.length);
  }, [cats.parents, isBusiness, showInactive]);

  const visible = (c: Category) => showInactive || c.active;
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const sort = (cats.parents.at(-1)?.sort_order ?? 0) + 10;
    save.mutate({ values: { name, sort_order: sort, color: SWATCHES[cats.parents.length % SWATCHES.length] } }, { onSuccess: () => setNewName("") });
  };

  return (
    <Page>
      <PageHeader
        title={isBusiness ? "Chart of accounts" : "Categories"}
        subtitle={
          isBusiness
            ? "Every transaction is assigned to an account below. The class decides where it lands on the profit & loss; tax lines map to Schedule C. Amounts are this month's activity."
            : "Edits apply immediately everywhere, including analytics. Spending shown is for this month."
        }
        actions={
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <Switch checked={showInactive} onChange={setShowInactive} label="Show inactive" /> Show inactive
          </label>
        }
      />
      <form onSubmit={add} className="mb-8 flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={isBusiness ? "New account group" : "New top-level category"}
          maxLength={80}
          className="max-w-xs"
          aria-label="New category name"
        />
        <Button type="submit" disabled={!newName.trim() || save.isPending}>
          <Plus /> {isBusiness ? "Add group" : "Add category"}
        </Button>
      </form>

      {cats.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : !cats.all.length ? (
        <EmptyState
          title={isBusiness ? "No chart of accounts yet." : "No categories yet."}
          body={
            isBusiness
              ? "Start from a standard small-business chart of accounts with Schedule C tax lines, or import a CSV to bring your own across."
              : "Start from a sensible default taxonomy, or import a CSV to bring your existing categories across."
          }
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => seed.mutate()} disabled={seed.isPending}>
                {isBusiness ? "Add standard chart of accounts" : "Add default categories"}
              </Button>
              <Link href="/settings/import">
                <Button>Import CSV</Button>
              </Link>
            </div>
          }
        />
      ) : (
        <div className="space-y-6">
          {sections.map((g) => (
            <div key={g.key} className="space-y-3">
              {g.heading ? <h2 className="pt-2 text-[11.5px] font-bold tracking-[0.08em] text-ink-2 uppercase">{g.heading}</h2> : null}
              {g.parents.map((p, i, arr) => {
                const kids = cats.childrenOf(p.id).filter(visible);
                const total = [p, ...cats.childrenOf(p.id)].reduce((s, c) => s + (spendBy.get(c.id) ?? 0), 0);
                return (
                  <section key={p.id} className="rounded-lg border border-line bg-surface">
                    <CategoryRow category={p} siblings={arr} index={i} spend={total} isParent onOpen={setViewing} onEdit={setEditing} />
                    {kids.length ? (
                      <ul className="border-t border-line-soft">
                        {kids.map((k, j) => (
                          <li key={k.id} className="border-b border-line-soft last:border-0">
                            <CategoryRow category={k} siblings={kids} index={j} spend={spendBy.get(k.id) ?? 0} onOpen={setViewing} onEdit={setEditing} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <AddChild parent={p} />
                  </section>
                );
              })}
            </div>
          ))}
          <p className="text-[12.5px] text-ink-3">
            {isBusiness
              ? "Owner's equity (money you put in or take out) and transfers are kept out of revenue, expenses and profit."
              : "Categories typed “Transfer (not counted)” are excluded from spending and income, like transfers."}
          </p>
        </div>
      )}
      <CategoryTransactionsPanel category={viewing} onClose={() => setViewing(null)} />
      {editing ? <CategoryEditDialog key={editing.id} category={editing} onClose={() => setEditing(null)} /> : null}
    </Page>
  );
}

function AddChild({ parent }: { parent: Category }) {
  const { isBusiness } = useWorkspace();
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const save = useSaveCategory();
  const cats = useCategoryIndex();
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 border-t border-line-soft px-4 py-2 pl-12 text-left text-[13px] text-ink-3 hover:text-ink-2"
      >
        <Plus className="size-3.5" /> {isBusiness ? "Add account" : "Add subcategory"}
      </button>
    );
  return (
    <form
      className="flex gap-2 border-t border-line-soft px-4 py-2 pl-12"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const sort = (cats.childrenOf(parent.id).at(-1)?.sort_order ?? 0) + 10;
        save.mutate(
          { values: { name: name.trim(), parent_category_id: parent.id, color: parent.color, category_type: parent.category_type, sort_order: sort } },
          { onSuccess: () => setName("") },
        );
      }}
    >
      <Input
        autoFocus
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        placeholder={isBusiness ? `New account in ${parent.name}` : `New subcategory of ${parent.name}`}
        aria-label="Subcategory name"
        className="max-w-xs"
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      <Button type="submit" size="md" disabled={!name.trim() || save.isPending}>
        Add
      </Button>
      <Button variant="quiet" onClick={() => setOpen(false)}>
        Done
      </Button>
    </form>
  );
}

function CategoryRow({
  category: c,
  siblings,
  index,
  spend,
  isParent,
  onOpen,
  onEdit,
}: {
  category: Category;
  siblings: Category[];
  index: number;
  spend: number;
  isParent?: boolean;
  onOpen: (c: Category) => void;
  onEdit: (c: Category) => void;
}) {
  const { isBusiness, canEdit } = useWorkspace();
  const save = useSaveCategory();
  const reorder = useReorderCategories();
  const del = useDeleteCategory();
  const confirm = useConfirm();
  const cats = useCategoryIndex();
  const set = (values: Parameters<typeof save.mutate>[0]["values"]) => save.mutate({ id: c.id, values });
  const typeLabels: Record<string, string> = isBusiness ? BUSINESS_CATEGORY_TYPES : CATEGORY_TYPES;
  const typeLabel = typeLabels[c.category_type] ?? c.category_type;

  const move = (dir: -1 | 1) => {
    const list = [...siblings];
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    [list[index], list[j]] = [list[j], list[index]];
    reorder.mutate(list.map((x, k) => ({ id: x.id, sort_order: (k + 1) * 10 })));
  };

  const remove = async () => {
    const kids = cats.childrenOf(c.id).length;
    const ok = await confirm({
      title: `Delete “${c.name}”?`,
      body: kids
        ? `Its ${kids} subcategories become top-level categories. Transactions in “${c.name}” become uncategorized. Consider deactivating instead.`
        : `Transactions in this category become uncategorized. Consider deactivating instead to keep history.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) del.mutate(c.id);
  };

  // Controls inside the row act on their own; a click anywhere else opens the transactions.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Show transactions in ${c.name}`}
      onClick={() => onOpen(c)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen(c);
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-4 py-2 outline-none hover:bg-hover/50 focus-visible:bg-hover/60",
        !isParent && "pl-12",
        !c.active && "opacity-55",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center">
        {c.icon ? <CategoryIcon name={c.icon} className="size-4" color={c.color} /> : <span className="size-3 rounded-full" style={{ background: c.color }} />}
      </span>
      {isBusiness ? <span className="w-14 shrink-0 font-mono text-[12.5px] text-ink-3">{c.code ?? ""}</span> : null}
      <span className={cn("min-w-0 flex-1 truncate text-[14.5px]", isParent && "font-medium")}>{c.name}</span>
      {isBusiness ? <span className="hidden w-36 shrink-0 truncate text-[12.5px] text-ink-3 lg:block">{isParent ? "" : (c.tax_line ?? "")}</span> : null}
      <span className="tabular hidden w-24 text-right text-[13px] text-ink-2 sm:block">{spend ? formatMoney(spend, { cents: false }) : ""}</span>
      {isParent ? <span className="hidden w-44 truncate text-[12.5px] text-ink-3 md:block">{typeLabel}</span> : <span className="hidden w-44 md:block" />}
      {canEdit ? (
        <span className="flex items-center" onClick={stop} onKeyDown={stop}>
          <IconButton label="Move up" size="sm" variant="quiet" disabled={index === 0} onClick={() => move(-1)}>
            <ArrowUp />
          </IconButton>
          <IconButton label="Move down" size="sm" variant="quiet" disabled={index === siblings.length - 1} onClick={() => move(1)}>
            <ArrowDown />
          </IconButton>
        </span>
      ) : null}
      <span onClick={stop} onKeyDown={stop}>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`More for ${c.name}`} size="sm" variant="quiet">
              <MoreHorizontal />
            </IconButton>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => onOpen(c)}>
              <ListIcon /> View transactions
            </MenuItem>
            {canEdit ? (
              <>
                <MenuItem onSelect={() => onEdit(c)}>
                  <Pencil /> Edit
                </MenuItem>
                <MenuItem onSelect={() => set({ active: !c.active })}>{c.active ? "Deactivate" : "Reactivate"}</MenuItem>
                {!isParent ? <MenuItem onSelect={() => set({ parent_category_id: null, sort_order: 10000 })}>Make top-level</MenuItem> : null}
                {!cats.childrenOf(c.id).length ? (
                  <>
                    <MenuSeparator />
                    <p className="px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">Move under</p>
                    <div className="max-h-48 overflow-y-auto">
                      {cats.parents
                        .filter((p) => p.id !== c.id && p.id !== c.parent_category_id)
                        .map((p) => (
                          <MenuItem key={p.id} onSelect={() => set({ parent_category_id: p.id })}>
                            {p.name}
                          </MenuItem>
                        ))}
                    </div>
                  </>
                ) : null}
                <MenuSeparator />
                <MenuItem danger onSelect={remove}>
                  <Trash2 /> Delete
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      </span>
    </div>
  );
}

/** Everything about a category in one form: name, number and tax line (business), type, color, icon, active. */
function CategoryEditDialog({ category: c, onClose }: { category: Category; onClose: () => void }) {
  const { isBusiness } = useWorkspace();
  const save = useSaveCategory();
  const cats = useCategoryIndex();
  const isParent = !c.parent_category_id;
  const [f, setF] = useState({
    name: c.name,
    code: c.code ?? "",
    tax_line: c.tax_line ?? "",
    category_type: c.category_type,
    color: c.color,
    icon: c.icon,
    active: c.active,
  });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const typeOptions = isBusiness ? BUSINESS_CATEGORY_TYPE_OPTIONS : CATEGORY_TYPE_OPTIONS;
  const codeOk = !f.code.trim() || /^[0-9A-Za-z.-]{1,12}$/.test(f.code.trim());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim() || !codeOk) return;
    save.mutate(
      {
        id: c.id,
        values: {
          name: f.name.trim(),
          code: f.code.trim() || null,
          tax_line: f.tax_line.trim() || null,
          category_type: f.category_type,
          color: f.color,
          icon: f.icon,
          active: f.active,
        },
      },
      {
        onSuccess: () => {
          // A group's type applies to its subcategories too, since each transaction is counted by its own category.
          if (isParent && f.category_type !== c.category_type) {
            cats.childrenOf(c.id).forEach((k) => k.category_type !== f.category_type && save.mutate({ id: k.id, values: { category_type: f.category_type } }));
          }
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={isBusiness ? `Edit account · ${c.name}` : `Edit category · ${c.name}`} className="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <div className={cn("grid gap-3", isBusiness ? "grid-cols-[110px_1fr]" : "grid-cols-1")}>
          {isBusiness ? (
            <Field label="Number" htmlFor="cat-code">
              <Input id="cat-code" value={f.code} maxLength={12} placeholder="e.g. 6210" onChange={(e) => set({ code: e.target.value })} />
            </Field>
          ) : null}
          <Field label="Name" htmlFor="cat-name">
            <Input id="cat-name" autoFocus value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </div>
        {isBusiness ? (
          <Field label="Tax line" htmlFor="cat-tax" hint="Where this goes on the tax return, e.g. Sch. C line 27a.">
            <Input id="cat-tax" value={f.tax_line} maxLength={80} onChange={(e) => set({ tax_line: e.target.value })} />
          </Field>
        ) : null}
        {isParent ? (
          <Field label={isBusiness ? "Class" : "Type"} htmlFor="cat-type" hint={cats.childrenOf(c.id).length ? "Applies to its subcategories too." : undefined}>
            <Select id="cat-type" value={f.category_type} onChange={(e) => set({ category_type: e.target.value })}>
              {typeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div>
          <p className="mb-1 text-[12px] font-medium tracking-wide text-ink-2">Color</p>
          <div className="flex flex-wrap gap-1.5">
            {SWATCHES.map((sw) => (
              <button
                key={sw}
                type="button"
                aria-label={`Color ${sw}`}
                aria-pressed={f.color.toLowerCase() === sw.toLowerCase()}
                onClick={() => set({ color: sw })}
                className={cn("size-7 rounded-md border-2", f.color.toLowerCase() === sw.toLowerCase() ? "border-ink" : "border-transparent")}
                style={{ background: sw }}
              />
            ))}
          </div>
        </div>
        <div>
          <p className="mb-1 text-[12px] font-medium tracking-wide text-ink-2">Icon</p>
          <div className="grid max-h-32 grid-cols-10 gap-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => set({ icon: null })}
              className={cn("flex size-7 items-center justify-center rounded-md text-[11px] text-ink-3 hover:bg-hover", !f.icon && "bg-selected")}
              aria-label="No icon"
            >
              —
            </button>
            {CATEGORY_ICON_NAMES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => set({ icon: n })}
                aria-label={`Icon ${n}`}
                className={cn("flex size-7 items-center justify-center rounded-md hover:bg-hover", f.icon === n && "bg-selected")}
              >
                <CategoryIcon name={n} className="size-4 text-ink-2" />
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Switch checked={f.active} onChange={(v) => set({ active: v })} label="Active" /> Active (inactive ones are hidden from pickers)
        </label>
        {!codeOk ? <p className="text-[12.5px] text-brick">The number can only use letters, digits, dots and dashes (up to 12).</p> : null}
        <div className="flex justify-end gap-2 border-t border-line-soft pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!f.name.trim() || !codeOk || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
