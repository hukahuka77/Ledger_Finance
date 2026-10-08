"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { CategoryPicker, CategoryPill } from "@/components/transactions/category-picker";
import { todayISO } from "@/lib/dates";
import { TRANSACTION_TYPE_OPTIONS, type LedgerTransaction, type TransactionType } from "@/lib/domain";
import { parseMoney } from "@/lib/money";
import { useAccounts, useCategoryIndex } from "@/lib/queries/reference";
import { useCreateTransaction } from "@/lib/queries/transactions";

export function AddTransactionDialog({
  open,
  onOpenChange,
  defaultAccountId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultAccountId?: string;
  onCreated?: (t: LedgerTransaction) => void;
}) {
  if (!open) return null;
  return <Inner onOpenChange={onOpenChange} defaultAccountId={defaultAccountId} onCreated={onCreated} />;
}

function Inner({
  onOpenChange,
  defaultAccountId,
  onCreated,
}: {
  onOpenChange: (o: boolean) => void;
  defaultAccountId?: string;
  onCreated?: (t: LedgerTransaction) => void;
}) {
  const { data: accounts } = useAccounts();
  const cats = useCategoryIndex();
  const create = useCreateTransaction();
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [date, setDate] = useState(todayISO());
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts?.find((a) => a.active)?.id ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [type, setType] = useState<TransactionType>("expense");
  const [status, setStatus] = useState<"posted" | "pending">("posted");
  const [notes, setNotes] = useState("");

  const parsed = parseMoney(amount);
  const valid = merchant.trim() && parsed !== null && accountId && date;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const magnitude = Math.abs(parsed!);
    create.mutate(
      {
        merchant_name: merchant.trim(),
        original_description: merchant.trim(),
        amount: direction === "out" ? -magnitude : magnitude,
        transaction_date: date,
        account_id: accountId,
        category_id: categoryId,
        transaction_type: type,
        status,
        notes: notes.trim() || null,
      },
      {
        onSuccess: (t) => {
          onCreated?.(t);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange} title="Add transaction" className="max-w-lg">
      {!accounts?.length ? (
        <p className="text-sm text-ink-2">Create an account first (Accounts → New account), or import a CSV.</p>
      ) : (
        <form onSubmit={submit} className="grid grid-cols-2 gap-4">
          <Field label="Merchant" htmlFor="tx-merchant" className="col-span-2">
            <Input id="tx-merchant" value={merchant} maxLength={200} onChange={(e) => setMerchant(e.target.value)} autoFocus />
          </Field>
          <Field label="Amount" htmlFor="tx-amount">
            <Input id="tx-amount" inputMode="decimal" className="tabular" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Direction">
            <Segmented
              ariaLabel="Direction"
              className="flex w-full [&>button]:flex-1"
              value={direction}
              onChange={(v) => {
                setDirection(v);
                if (v === "in" && type === "expense") setType("income");
                if (v === "out" && type === "income") setType("expense");
              }}
              options={[
                { value: "out", label: "Money out" },
                { value: "in", label: "Money in" },
              ]}
            />
          </Field>
          <Field label="Date" htmlFor="tx-date">
            <Input id="tx-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Account" htmlFor="tx-account">
            <Select id="tx-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.last_four ? ` ··${a.last_four}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <CategoryPicker value={categoryId} onChange={setCategoryId}>
              <button type="button" className="flex h-8 w-full items-center rounded-md border border-line bg-surface px-2 hover:bg-hover">
                <CategoryPill category={categoryId ? cats.byId.get(categoryId) : null} />
              </button>
            </CategoryPicker>
          </Field>
          <Field label="Type" htmlFor="tx-type">
            <Select id="tx-type" value={type} onChange={(e) => setType(e.target.value as TransactionType)}>
              {TRANSACTION_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status" htmlFor="tx-status">
            <Select id="tx-status" value={status} onChange={(e) => setStatus(e.target.value as "posted" | "pending")}>
              <option value="posted">Posted</option>
              <option value="pending">Pending</option>
            </Select>
          </Field>
          <Field label="Notes" htmlFor="tx-notes" className="col-span-2">
            <Textarea id="tx-notes" className="min-h-16" value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="col-span-2 flex justify-end gap-2 border-t border-line-soft pt-4">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!valid || create.isPending}>
              {create.isPending ? "Adding…" : "Add transaction"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
