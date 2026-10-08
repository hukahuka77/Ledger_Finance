"use client";

import { useIsMutating } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowLeftRight,
  CalendarDays,
  Check,
  Circle,
  Copy,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Repeat,
  Split,
  Trash2,
  Unlink,
  Wand2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { RecurringFormDialog } from "@/components/forms/recurring-form";
import { RuleFormDialog } from "@/components/forms/rule-form";
import { AutosaveTextarea, InlineText } from "@/components/transactions/inline-fields";
import { CategoryPicker, CategoryPill } from "@/components/transactions/category-picker";
import { SplitDialog } from "@/components/transactions/split-dialog";
import { TagChip, TagPicker } from "@/components/transactions/tag-picker";
import { Button, IconButton } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatLongDate, formatMediumDate, formatShortDate } from "@/lib/dates";
import { NON_COUNTING_TYPES, TRANSACTION_TYPE_OPTIONS, type LedgerTransaction, type TransactionType } from "@/lib/domain";
import { formatLedgerAmount, formatMoney, parseMoney } from "@/lib/money";
import { useAccountIndex, useAccounts, useCategoryIndex, useRecurringIndex, useTagIndex } from "@/lib/queries/reference";
import {
  TXN_MUTATION_KEY,
  useDeleteTransactions,
  useDuplicateTransaction,
  useLinkTransfer,
  useSetTransactionTags,
  useTransaction,
  useTransferCandidates,
  useTransferLegs,
  useUnlinkTransfer,
  useUpdateTransaction,
} from "@/lib/queries/transactions";
import type { TablesUpdate } from "@/lib/database.types";

export function SaveIndicator() {
  const saving = useIsMutating({ mutationKey: TXN_MUTATION_KEY });
  const [everSaved, setEverSaved] = useState(false);
  if (saving && !everSaved) setEverSaved(true);
  return (
    <span className="text-[12px] text-ink-3" aria-live="polite">
      {saving ? "Saving…" : everSaved ? "Saved" : ""}
    </span>
  );
}

export function TransactionDetail({
  id,
  onClose,
  onToggleReview,
  onMarkTransfer,
  onDeleted,
  categoryOpen,
  setCategoryOpen,
  showBack,
}: {
  id: string;
  onClose: () => void;
  onToggleReview: (t: LedgerTransaction) => void;
  onMarkTransfer: (t: LedgerTransaction) => void;
  onDeleted: (id: string) => void;
  categoryOpen: boolean;
  setCategoryOpen: (o: boolean) => void;
  showBack?: boolean;
}) {
  const { data: txn, isLoading, error } = useTransaction(id);

  if (isLoading && !txn) return <DetailSkeleton onClose={onClose} />;
  if (error || !txn) {
    return (
      <div className="flex h-full flex-col">
        <DetailHeader onClose={onClose} showBack={showBack} />
        <p className="p-6 text-sm text-ink-2">This transaction no longer exists.</p>
      </div>
    );
  }
  return (
    <DetailBody
      key={txn.id}
      txn={txn}
      onClose={onClose}
      onToggleReview={onToggleReview}
      onMarkTransfer={onMarkTransfer}
      onDeleted={onDeleted}
      categoryOpen={categoryOpen}
      setCategoryOpen={setCategoryOpen}
      showBack={showBack}
    />
  );
}

function DetailHeader({ children, onClose, showBack }: { children?: React.ReactNode; onClose: () => void; showBack?: boolean }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 sm:px-5">
      {showBack ? (
        <IconButton label="Back to list" variant="quiet" onClick={onClose}>
          <ArrowLeft />
        </IconButton>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="text-[15px] font-medium text-ink">Transaction</span>
      </div>
      {children}
      {!showBack ? (
        <IconButton label="Close details (Esc)" variant="quiet" onClick={onClose}>
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}

function DetailSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <DetailHeader onClose={onClose} />
      <div className="space-y-4 p-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-32" />
        <div className="grid grid-cols-2 gap-4 pt-4">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      </div>
    </div>
  );
}

function Row({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[108px_1fr] items-center gap-3 py-1.5", className)}>
      <span className="text-[13px] text-ink-2">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function DetailBody({
  txn,
  onClose,
  onToggleReview,
  onMarkTransfer,
  onDeleted,
  categoryOpen,
  setCategoryOpen,
  showBack,
}: {
  txn: LedgerTransaction;
  onClose: () => void;
  onToggleReview: (t: LedgerTransaction) => void;
  onMarkTransfer: (t: LedgerTransaction) => void;
  onDeleted: (id: string) => void;
  categoryOpen: boolean;
  setCategoryOpen: (o: boolean) => void;
  showBack?: boolean;
}) {
  const accounts = useAccountIndex();
  const { data: accountList } = useAccounts();
  const cats = useCategoryIndex();
  const tags = useTagIndex();
  const recurring = useRecurringIndex();
  const update = useUpdateTransaction();
  const setTags = useSetTransactionTags();
  const del = useDeleteTransactions();
  const duplicate = useDuplicateTransaction();
  const confirm = useConfirm();
  const merchantRef = useRef<HTMLDivElement>(null);

  const [splitOpen, setSplitOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);

  const account = accounts.get(txn.account_id);
  const category = txn.category_id ? cats.byId.get(txn.category_id) : undefined;
  const parent = cats.parentOf(txn.category_id);
  const reviewed = txn.review_status === "reviewed";
  const isSplit = txn.transaction_splits.length > 0;
  const recurringItem = txn.recurring_item_id ? recurring.get(txn.recurring_item_id) : undefined;
  const tagIds = txn.transaction_tags.map((t) => t.tag_id);
  const notCounted =
    txn.excluded ||
    NON_COUNTING_TYPES.includes(txn.transaction_type as TransactionType) ||
    category?.category_type === "transfer" ||
    category?.category_type === "equity";

  const save = (patch: TablesUpdate<"transactions">) => update.mutate({ id: txn.id, patch });

  const toggleTag = (tagId: string, on: boolean) => {
    const next = on ? [...new Set([...tagIds, tagId])] : tagIds.filter((t) => t !== tagId);
    setTags.mutate({ id: txn.id, add: on ? [tagId] : [], remove: on ? [] : [tagId], next });
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Delete this transaction?",
      body: `${txn.merchant_name} · ${formatMoney(txn.amount)} will be permanently deleted.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) del.mutate([txn.id], { onSuccess: () => onDeleted(txn.id) });
  };

  return (
    <div className="flex h-full flex-col">
      <DetailHeader onClose={onClose} showBack={showBack}>
        <Button
          size="sm"
          variant={reviewed ? "secondary" : "primary"}
          onClick={() => onToggleReview(txn)}
          title="Toggle reviewed (R)"
          className={cn(reviewed && "text-sage")}
        >
          {reviewed ? <Check /> : <Circle />}
          {reviewed ? "Reviewed" : "Mark reviewed"}
        </Button>
        <Button size="sm" onClick={() => setSplitOpen(true)} className="hidden sm:inline-flex">
          <Split /> Split
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="More actions" variant="secondary" size="sm">
              <MoreHorizontal />
            </IconButton>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => onToggleReview(txn)}>
              {reviewed ? <Circle /> : <Check />} {reviewed ? "Mark unreviewed" : "Mark reviewed"}
            </MenuItem>
            <MenuItem onSelect={() => onMarkTransfer(txn)}>
              <ArrowLeftRight />{" "}
              {txn.transaction_type === "transfer" || txn.transaction_type === "credit_card_payment" ? "Mark as expense/income" : "Mark as transfer"}
            </MenuItem>
            <MenuItem onSelect={() => setSplitOpen(true)}>
              <Split /> {isSplit ? "Edit split" : "Split"}
            </MenuItem>
            <MenuItem onSelect={() => merchantRef.current?.querySelector("input")?.focus()}>
              <Pencil /> Edit merchant
            </MenuItem>
            <MenuItem onSelect={() => duplicate.mutate(txn)}>
              <Copy /> Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => setRuleOpen(true)}>
              <Wand2 /> Create categorization rule
            </MenuItem>
            <MenuItem onSelect={() => setRecurringOpen(true)}>
              <Repeat /> {recurringItem ? "Edit recurring item" : "Create recurring item"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={remove}>
              <Trash2 /> Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </DetailHeader>

      <div className="flex-1 overflow-y-auto px-5 pt-6 pb-10 sm:px-7">
        {/* Date / status line */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
          <label className="relative flex cursor-pointer items-center gap-1.5 hover:text-ink">
            <CalendarDays className="size-3.5" />
            {formatLongDate(txn.transaction_date)}
            <input
              type="date"
              aria-label="Transaction date"
              value={txn.transaction_date}
              onChange={(e) => e.target.value && save({ transaction_date: e.target.value })}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
          <span className={cn("flex items-center gap-1.5", reviewed ? "text-sage" : "text-accent")}>
            {reviewed ? <Check className="size-3.5" /> : <span className="size-1.5 rounded-full bg-accent" />}
            {reviewed ? "Reviewed" : "To review"}
          </span>
          <span className="ml-auto">
            <SaveIndicator />
          </span>
        </div>

        {/* Merchant + amount */}
        <div className="mt-3 flex items-start justify-between gap-4">
          <div ref={merchantRef} className="min-w-0 flex-1">
            <InlineText
              ariaLabel="Merchant"
              value={txn.merchant_name}
              required
              onSave={(v) => save({ merchant_name: v })}
              className="font-serif text-[26px] leading-tight text-ink"
            />
            {txn.original_description && txn.original_description !== txn.merchant_name ? (
              <p className="mt-1 truncate font-mono text-[11.5px] text-ink-3" title={txn.original_description}>
                {txn.original_description}
              </p>
            ) : null}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[12px] tracking-wide text-ink-3 uppercase">{txn.status}</p>
            <p className={cn("tabular font-serif text-[26px] leading-tight", txn.amount > 0 ? "text-sage" : "text-ink")}>{formatLedgerAmount(txn.amount)}</p>
          </div>
        </div>

        {notCounted ? (
          <p className="mt-3 rounded-md border border-line bg-sidebar px-3 py-2 text-[12.5px] text-ink-2">
            Not counted in spending or income
            {txn.excluded
              ? " (excluded)"
              : category?.category_type === "equity"
                ? " (owner's equity)"
                : ` (${TRANSACTION_TYPE_OPTIONS.find((o) => o.value === txn.transaction_type)?.label.toLowerCase() ?? "transfer"})`}
            .
          </p>
        ) : null}

        {/* Core fields */}
        <div className="mt-6 border-t border-line-soft pt-3">
          <Row label="Category">
            {isSplit ? (
              <button type="button" onClick={() => setSplitOpen(true)} className="text-sm text-ink-2 hover:text-ink">
                Split across {txn.transaction_splits.length} categories · Edit
              </button>
            ) : (
              <CategoryPicker value={txn.category_id} onChange={(cid) => save({ category_id: cid })} open={categoryOpen} onOpenChange={setCategoryOpen}>
                <button type="button" title="Change category (C)" className="-mx-1.5 flex max-w-full items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
                  <CategoryPill category={category} transactionType={txn.transaction_type} />
                  {parent ? <span className="truncate text-[12px] text-ink-3">in {parent.name}</span> : null}
                </button>
              </CategoryPicker>
            )}
          </Row>
          <Row label="Account">
            <Select aria-label="Account" value={txn.account_id} onChange={(e) => save({ account_id: e.target.value })}>
              {(accountList ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.last_four ? ` ••${a.last_four}` : ""}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Type">
            <Select aria-label="Transaction type" value={txn.transaction_type} onChange={(e) => save({ transaction_type: e.target.value })}>
              {TRANSACTION_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Amount">
            <AmountEditor amount={txn.amount} disabled={isSplit} onSave={(v) => save({ amount: v })} />
          </Row>
          <Row label="Status">
            <Segmented
              size="sm"
              ariaLabel="Status"
              value={txn.status as "pending" | "posted"}
              onChange={(v) => save({ status: v })}
              options={[
                { value: "pending", label: "Pending" },
                { value: "posted", label: "Cleared" },
              ]}
            />
          </Row>
          <Row label="Exclude">
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <Switch checked={txn.excluded} onChange={(v) => save({ excluded: v })} label="Exclude from analytics" />
              Hide from spending & income
            </label>
          </Row>
        </div>

        {isSplit ? (
          <Section
            title="Split"
            action={
              <Button size="sm" variant="quiet" onClick={() => setSplitOpen(true)}>
                Edit
              </Button>
            }
          >
            <ul className="divide-y divide-line-soft rounded-md border border-line">
              {[...txn.transaction_splits]
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((s) => (
                  <li key={s.id} className="flex items-center gap-2 px-3 py-2">
                    <CategoryPill category={s.category_id ? cats.byId.get(s.category_id) : null} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">{s.notes}</span>
                    <span className="tabular text-sm">{formatMoney(s.amount)}</span>
                  </li>
                ))}
            </ul>
          </Section>
        ) : null}

        <TransferSection txn={txn} />

        <Section title="Recurring">
          {recurringItem ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
              <Link href={`/recurring/${recurringItem.id}`} className="flex min-w-0 items-center gap-2 text-sm hover:underline">
                <Repeat className="size-3.5 text-ink-3" />
                <span className="truncate">{recurringItem.name}</span>
                <span className="text-ink-3">· next {formatShortDate(recurringItem.next_expected_date)}</span>
              </Link>
              <IconButton label="Unlink from recurring" size="sm" variant="quiet" onClick={() => save({ recurring_item_id: null })}>
                <Unlink />
              </IconButton>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setRecurringOpen(true)}>
              <Repeat /> Mark recurring
            </Button>
          )}
        </Section>

        <Section title="Tags">
          <div className="flex flex-wrap items-center gap-1.5">
            {tagIds.map((tid) => {
              const t = tags.get(tid);
              return t ? <TagChip key={tid} tag={t} onRemove={() => toggleTag(tid, false)} /> : null;
            })}
            <TagPicker selected={tagIds} onToggle={toggleTag}>
              <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink">
                <Plus className="size-3.5" /> Add tag
              </button>
            </TagPicker>
          </div>
        </Section>

        <Section title="Notes">
          <AutosaveTextarea ariaLabel="Notes" value={txn.notes ?? ""} placeholder="Add a note…" onSave={(v) => save({ notes: v.trim() ? v : null })} />
        </Section>

        <p className="mt-8 text-[12px] leading-relaxed text-ink-3">
          {account ? `${account.name}${account.last_four ? ` ••${account.last_four}` : ""}` : ""}
          {txn.import_id ? " · Imported" : " · Added manually"} {formatMediumDate(txn.created_at.slice(0, 10))}
          {txn.reviewed_at ? ` · Reviewed ${formatMediumDate(txn.reviewed_at.slice(0, 10))}` : ""}
        </p>
      </div>

      <SplitDialog txn={txn} open={splitOpen} onOpenChange={setSplitOpen} />
      <RuleFormDialog open={ruleOpen} onOpenChange={setRuleOpen} fromTransaction={txn} />
      <RecurringFormDialog open={recurringOpen} onOpenChange={setRecurringOpen} item={recurringItem} fromTransaction={recurringItem ? undefined : txn} />
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-medium text-ink-2">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function AmountEditor({ amount, onSave, disabled }: { amount: number; onSave: (v: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const direction = amount > 0 ? "in" : "out";
  const commit = () => {
    if (draft === null) return;
    const v = parseMoney(draft);
    setDraft(null);
    if (v === null) return;
    const signed = direction === "in" ? Math.abs(v) : -Math.abs(v);
    if (signed !== amount) onSave(signed);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label="Amount"
        inputMode="decimal"
        disabled={disabled}
        title={disabled ? "Edit or remove the split to change the amount" : undefined}
        value={draft ?? Math.abs(amount).toFixed(2)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            e.stopPropagation();
          }
        }}
        className="tabular h-8 w-28 rounded-md border border-line bg-surface px-2.5 text-right text-sm focus:border-accent/60 focus:ring-2 focus:ring-accent/15 focus:outline-none disabled:opacity-60"
      />
      <Segmented
        size="sm"
        ariaLabel="Direction"
        value={direction}
        onChange={(d) => !disabled && d !== direction && onSave(-amount)}
        options={[
          { value: "out", label: "Out" },
          { value: "in", label: "In" },
        ]}
      />
    </div>
  );
}

function TransferSection({ txn }: { txn: LedgerTransaction }) {
  const isTransferType = txn.transaction_type === "transfer" || txn.transaction_type === "credit_card_payment";
  const legs = useTransferLegs(txn.transfer_group_id, txn.id);
  const candidates = useTransferCandidates(txn, isTransferType && !txn.transfer_group_id);
  const accounts = useAccountIndex();
  const link = useLinkTransfer();
  const unlink = useUnlinkTransfer();

  if (!isTransferType && !txn.transfer_group_id) return null;

  return (
    <Section title="Transfer">
      {txn.transfer_group_id ? (
        <div className="rounded-md border border-line">
          {(legs.data ?? []).map((l) => (
            <div key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <ArrowLeftRight className="size-3.5 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">
                {accounts.get(l.account_id)?.name ?? "Account"} · {formatShortDate(l.transaction_date)}
              </span>
              <span className="tabular">{formatLedgerAmount(l.amount)}</span>
            </div>
          ))}
          {legs.data && legs.data.length === 0 ? <p className="px-3 py-2 text-sm text-ink-3">Marked as a transfer (no linked counterpart).</p> : null}
          <div className="border-t border-line-soft px-3 py-1.5">
            <Button size="sm" variant="quiet" onClick={() => unlink.mutate(txn.transfer_group_id!)}>
              <Unlink /> Unlink
            </Button>
          </div>
        </div>
      ) : (
        <div>
          {candidates.isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : candidates.data?.length ? (
            <div className="rounded-md border border-line">
              <p className="border-b border-line-soft px-3 py-1.5 text-[12px] text-ink-3">Possible other side of this transfer</p>
              {candidates.data.map((c) => (
                <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {accounts.get(c.account_id)?.name ?? "Account"} · {c.merchant_name} · {formatShortDate(c.transaction_date)}
                  </span>
                  <span className="tabular text-ink-2">{formatLedgerAmount(c.amount)}</span>
                  <Button
                    size="sm"
                    onClick={() =>
                      link.mutate({
                        ids: [txn.id, c.id],
                        // Paying a card from another account is a card payment on both legs.
                        type: [txn.account_id, c.account_id].some((id) => accounts.get(id)?.account_type === "credit_card")
                          ? "credit_card_payment"
                          : "transfer",
                      })
                    }
                  >
                    <Link2 /> Link
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">No matching opposite transaction found within 5 days.</p>
          )}
        </div>
      )}
    </Section>
  );
}
