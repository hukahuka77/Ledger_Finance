"use client";

import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AccountFormDialog } from "@/components/accounts/account-form";
import { SyncControl } from "@/components/shared/sync-control";
import { useCoinbaseConnections } from "@/lib/queries/coinbase";
import { usePlaidItems } from "@/lib/queries/plaid";
import { Page, SectionHeading } from "@/components/layout/app-shell";
import { CategoryBars, rollupSpending } from "@/components/shared/category-bars";
import { MiniTransactionList } from "@/components/shared/mini-transaction-list";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { formatMediumDate, PERIOD_OPTIONS, periodRange, type PeriodKey } from "@/lib/dates";
import { ACCOUNT_TYPE_SINGULAR, isLiability, type Account, type AccountType } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { useCashflow, useRecentTransactions, useSpendingByCategory } from "@/lib/queries/analytics";
import { useAccountIndex, useAccounts, useCategoryIndex, useDeleteAccount } from "@/lib/queries/reference";

export function AccountDetail({ id }: { id: string }) {
  const router = useRouter();
  const { isLoading } = useAccounts();
  const accounts = useAccountIndex();
  const account = accounts.get(id);
  const cats = useCategoryIndex();
  const [period, setPeriod] = useState<PeriodKey>("this_month");
  const range = periodRange(period === "custom" ? "this_month" : period);
  const spending = useSpendingByCategory(range.from, range.to, id);
  const cash = useCashflow(range.from, range.to, id);
  const recent = useRecentTransactions(25, id);
  const del = useDeleteAccount();
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);
  const coinbaseConn = useCoinbaseConnections().data?.find((c) => c.account_id === id);
  const plaidItem = usePlaidItems().data?.find((i) => i.id === account?.plaid_item_id);
  const rollup = useMemo(() => rollupSpending(spending.data ?? [], cats), [spending.data, cats]);

  if (isLoading)
    return (
      <Page>
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  if (!account)
    return (
      <Page>
        <EmptyState
          title="Account not found."
          action={
            <Link href="/accounts">
              <Button>Back to accounts</Button>
            </Link>
          }
        />
      </Page>
    );

  const type = account.account_type as AccountType;
  const card = type === "credit_card";
  const liability = isLiability(type);
  const autopayFrom = account.autopay_account_id ? accounts.get(account.autopay_account_id) : undefined;

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${account.name}?`,
      body: "This permanently deletes the account and every transaction in it. To keep history, mark it inactive instead.",
      confirmLabel: "Delete account",
      danger: true,
      typeToConfirm: account.name,
    });
    if (ok) del.mutate(account.id, { onSuccess: () => router.replace("/accounts") });
  };

  return (
    <Page>
      <Link href="/accounts" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink-2">
        <ArrowLeft className="size-3.5" /> Accounts
      </Link>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
            {ACCOUNT_TYPE_SINGULAR[type]}
            {account.institution ? ` · ${account.institution}` : ""}
            {account.last_four ? ` · ··${account.last_four}` : ""}
          </p>
          <h1 className="mt-1 font-serif text-[28px] leading-tight">{account.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {account.plaid_item_id ? <SyncControl itemId={account.plaid_item_id} /> : coinbaseConn ? <SyncControl itemId={coinbaseConn.id} /> : null}
          <Button onClick={() => setEditOpen(true)}>
            <Pencil /> Edit
          </Button>
          <Button variant="danger" onClick={remove}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
        <Stat
          label={liability ? "Current balance owed" : "Current balance"}
          value={formatMoney(account.current_balance)}
          hint={account.balance_as_of ? `as of ${formatMediumDate(account.balance_as_of)}` : "not set"}
        />
        {card ? (
          <>
            <Stat label="Credit limit" value={account.credit_limit !== null ? formatMoney(account.credit_limit, { cents: false }) : "—"} />
            <Stat
              label="Available credit"
              value={
                account.credit_limit !== null
                  ? formatMoney(account.credit_limit - account.current_balance)
                  : account.available_balance !== null
                    ? formatMoney(account.available_balance)
                    : "—"
              }
            />
            <Stat
              label="Statement balance"
              value={account.statement_balance !== null ? formatMoney(account.statement_balance) : "—"}
              hint={account.last_statement_date ? `issued ${formatMediumDate(account.last_statement_date)}` : undefined}
            />
          </>
        ) : account.available_balance !== null ? (
          <Stat label="Available" value={formatMoney(account.available_balance)} />
        ) : null}
        {liability ? (
          <>
            <Stat
              label="Payment due"
              value={
                account.next_payment_due_date
                  ? formatMediumDate(account.next_payment_due_date)
                  : account.payment_due_day
                    ? `Day ${account.payment_due_day}`
                    : "—"
              }
              hint={
                account.is_overdue ? (
                  <span className="font-medium text-brick">Overdue</span>
                ) : account.minimum_payment !== null ? (
                  `min ${formatMoney(account.minimum_payment)}`
                ) : undefined
              }
            />
            {card ? (
              <Stat
                label="Statement closes"
                value={account.statement_close_day ? `Day ${account.statement_close_day}` : "—"}
                hint={account.last_statement_date ? `last closed ${formatMediumDate(account.last_statement_date)}` : undefined}
              />
            ) : null}
            <Stat label="Autopay" value={account.autopay_enabled ? "On" : "Off"} hint={autopayFrom ? `from ${autopayFrom.name}` : undefined} />
            {card && account.last_payment_date ? (
              <Stat
                label="Last payment"
                value={account.last_payment_amount !== null ? formatMoney(account.last_payment_amount) : "—"}
                hint={`on ${formatMediumDate(account.last_payment_date)}`}
              />
            ) : null}
          </>
        ) : null}
      </dl>
      {card && plaidItem?.liabilities_status === "consent_required" ? (
        <p className="mt-3 text-[13px] text-ink-2">
          Statement balance and due date need a one-time permission from {plaidItem.institution_name ?? "your bank"}.{" "}
          <Link href="/settings/connections" className="text-ink underline">
            Grant it on Bank connections
          </Link>
          .
        </p>
      ) : null}

      <AccountDetails
        account={account}
        linkedTo={plaidItem ? (plaidItem.institution_name ?? "Bank") + " (Plaid)" : coinbaseConn ? "Coinbase" : null}
        onEdit={() => setEditOpen(true)}
      />

      <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1fr]">
        <section className="min-w-0">
          <SectionHeading
            actions={
              <Select aria-label="Period" className="w-36" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}>
                {PERIOD_OPTIONS.filter((o) => o.value !== "custom").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            }
          >
            Spending by category
          </SectionHeading>
          <p className="tabular mb-3 text-[13px] text-ink-2">
            Spent {formatMoney(cash.data?.spending ?? 0)} · Income {formatMoney(cash.data?.income ?? 0)} · {range.label}
          </p>
          {spending.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : rollup.length ? (
            <CategoryBars rows={rollup} from={range.from} to={range.to} accountId={account.id} limit={6} />
          ) : (
            <p className="text-sm text-ink-3">No spending in this period.</p>
          )}
        </section>
        <section className="min-w-0">
          <SectionHeading
            actions={
              <Link href={`/transactions?account=${account.id}`} className="text-[12.5px] text-ink-2 hover:text-ink">
                Open in ledger
              </Link>
            }
          >
            Transactions
          </SectionHeading>
          <MiniTransactionList rows={recent.data} loading={recent.isLoading} showAccount={false} empty="No transactions in this account yet." />
        </section>
      </div>
      <AccountFormDialog open={editOpen} onOpenChange={setEditOpen} account={account} />
    </Page>
  );
}

/** Notes and the account's descriptive details, so what's entered in Edit is visible here. */
function AccountDetails({ account, linkedTo, onEdit }: { account: Account; linkedTo: string | null; onEdit: () => void }) {
  const rows: [string, React.ReactNode][] = [
    ["Institution", account.institution],
    ["Account number", account.last_four ? `ending ${account.last_four}` : null],
    ["Synced from", linkedTo],
    ["Transactions", account.track_transactions ? "Tracked" : "Not tracked: balance only"],
    ["Currency", account.currency !== "USD" ? account.currency : null],
    ["Status", account.active ? null : "Inactive (hidden from the sidebar and totals)"],
  ];
  const shown = rows.filter(([, v]) => v);
  return (
    <section className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-[13.5px]">
        {shown.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-3">{label}</dt>
            <dd className="text-ink-2">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1 text-[12px] text-ink-2">Notes</p>
        {account.notes ? (
          <p className="text-[13.5px] whitespace-pre-wrap text-ink">{account.notes}</p>
        ) : (
          <button type="button" onClick={onEdit} className="text-[13.5px] text-ink-3 hover:text-ink-2 hover:underline">
            Add a note
          </button>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div className="pr-4">
      <dt className="text-[12px] text-ink-2">{label}</dt>
      <dd className="tabular mt-1 font-serif text-[22px] leading-none">{value}</dd>
      {hint ? <dd className="mt-1 text-[12px] text-ink-3">{hint}</dd> : null}
    </div>
  );
}
