"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CategoryPicker, CategoryPill } from "@/components/transactions/category-picker";
import type { LedgerTransaction } from "@/lib/domain";
import { formatMoney, fromCents, parseMoney, toCents } from "@/lib/money";
import { useCategoryIndex } from "@/lib/queries/reference";
import { useSetSplits } from "@/lib/queries/transactions";

type Part = { key: number; category_id: string | null; amount: string; notes: string };

function initialParts(t: LedgerTransaction): Part[] {
  if (t.transaction_splits.length) {
    return [...t.transaction_splits]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s, i) => ({ key: i, category_id: s.category_id, amount: Math.abs(s.amount).toFixed(2), notes: s.notes ?? "" }));
  }
  return [
    { key: 0, category_id: t.category_id, amount: Math.abs(t.amount).toFixed(2), notes: "" },
    { key: 1, category_id: null, amount: "", notes: "" },
  ];
}

export function SplitDialog({ txn, open, onOpenChange }: { txn: LedgerTransaction; open: boolean; onOpenChange: (o: boolean) => void }) {
  return open ? <SplitDialogInner key={txn.id} txn={txn} onOpenChange={onOpenChange} /> : null;
}

function SplitDialogInner({ txn, onOpenChange }: { txn: LedgerTransaction; onOpenChange: (o: boolean) => void }) {
  const [parts, setParts] = useState<Part[]>(() => initialParts(txn));
  const [nextKey, setNextKey] = useState(10);
  const cats = useCategoryIndex();
  const save = useSetSplits();

  const totalCents = Math.abs(toCents(txn.amount));
  const allocated = parts.reduce((s, p) => s + Math.abs(toCents(parseMoney(p.amount) ?? 0)), 0);
  const remaining = totalCents - allocated;
  const invalid = parts.some((p) => parseMoney(p.amount) === null || (parseMoney(p.amount) ?? 0) <= 0);
  const canSave = parts.length >= 2 && remaining === 0 && !invalid;
  const sign = txn.amount < 0 ? -1 : 1;

  const update = (key: number, patch: Partial<Part>) => setParts((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const submit = () => {
    save.mutate(
      {
        id: txn.id,
        splits: parts.map((p) => ({ category_id: p.category_id, amount: sign * Math.abs(parseMoney(p.amount)!), notes: p.notes.trim() || null })),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Split transaction"
      description={`${txn.merchant_name} · ${formatMoney(txn.amount)}. Each part is counted in its own category.`}
      className="max-w-xl"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {txn.transaction_splits.length ? (
            <Button
              variant="danger"
              onClick={() => save.mutate({ id: txn.id, splits: [] }, { onSuccess: () => onOpenChange(false) })}
              disabled={save.isPending}
            >
              Remove split
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={!canSave || save.isPending}>
              {save.isPending ? "Saving…" : "Save split"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center gap-2">
            <CategoryPicker value={p.category_id} onChange={(id) => update(p.key, { category_id: id })}>
              <button type="button" className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-line bg-surface px-2 hover:bg-hover">
                <CategoryPill category={p.category_id ? cats.byId.get(p.category_id) : null} />
              </button>
            </CategoryPicker>
            <Input
              className="w-28 text-right tabular"
              inputMode="decimal"
              aria-label="Amount"
              placeholder="0.00"
              value={p.amount}
              onChange={(e) => update(p.key, { amount: e.target.value })}
            />
            <Input
              className="hidden w-36 sm:block"
              aria-label="Note"
              placeholder="Note"
              value={p.notes}
              maxLength={500}
              onChange={(e) => update(p.key, { notes: e.target.value })}
            />
            <IconButton
              label="Remove part"
              variant="quiet"
              size="sm"
              disabled={parts.length <= 2}
              onClick={() => setParts((ps) => ps.filter((x) => x.key !== p.key))}
            >
              <Trash2 />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Button
          size="sm"
          variant="quiet"
          disabled={parts.length >= 20}
          onClick={() => {
            setParts((ps) => [...ps, { key: nextKey, category_id: null, amount: remaining > 0 ? fromCents(remaining).toFixed(2) : "", notes: "" }]);
            setNextKey((k) => k + 1);
          }}
        >
          <Plus /> Add part
        </Button>
        <p className={`tabular text-sm ${remaining === 0 ? "text-ink-2" : "text-brick"}`}>
          {remaining === 0
            ? "Fully allocated"
            : remaining > 0
              ? `${formatMoney(fromCents(remaining))} left to allocate`
              : `${formatMoney(fromCents(-remaining))} over`}
        </p>
      </div>
    </Dialog>
  );
}
