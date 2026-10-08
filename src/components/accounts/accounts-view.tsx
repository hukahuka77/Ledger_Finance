"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AccountFormDialog } from "@/components/accounts/account-form";
import { SyncControl } from "@/components/shared/sync-control";
import { Page, PageHeader } from "@/components/layout/app-shell";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMediumDate, todayISO } from "@/lib/dates";
import { ACCOUNT_TYPES, isLiability, type Account, type AccountType } from "@/lib/domain";
import { formatMoney, formatSigned, parseMoney } from "@/lib/money";
import { useAccounts, useSaveAccount } from "@/lib/queries/reference";

const ORDER: AccountType[] = ["checking", "savings", "credit_card", "brokerage", "retirement", "cash", "loan", "mortgage", "other"];

export function AccountsView() {
  const { data: accounts, isLoading } = useAccounts();
  const { isBusiness } = useWorkspace();
  const [formOpen, setFormOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const groups = useMemo(
    () =>
      ORDER.map((type) => ({ type, accounts: (accounts ?? []).filter((a) => a.account_type === type && (showInactive || a.active)) })).filter(
        (g) => g.accounts.length,
      ),
    [accounts, showInactive],
  );
  const totals = useMemo(() => {
    const active = (accounts ?? []).filter((a) => a.active);
    const assets = active.filter((a) => !isLiability(a.account_type)).reduce((s, a) => s + a.current_balance, 0);
    const liabilities = active.filter((a) => isLiability(a.account_type)).reduce((s, a) => s + a.current_balance, 0);
    return { assets, liabilities, net: assets - liabilities };
  }, [accounts]);

  return (
    <Page>
      <PageHeader
        title="Accounts"
        subtitle={
          accounts?.length ? (
            <span className="tabular">
              {isBusiness ? "Net position" : "Net worth"} {formatSigned(totals.net, { cents: false })} · Assets {formatMoney(totals.assets, { cents: false })} ·
              Liabilities {formatMoney(totals.liabilities, { cents: false })}
            </span>
          ) : undefined
        }
        actions={
          <>
            <SyncControl />
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <Switch checked={showInactive} onChange={setShowInactive} label="Show inactive" /> Show inactive
            </label>
            <Button variant="primary" onClick={() => setFormOpen(true)}>
              <Plus /> New account
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !groups.length ? (
        <EmptyState
          title="No accounts yet."
          body="Accounts are created automatically when you import a CSV, or you can add one by hand."
          action={
            <div className="flex gap-2">
              <Link href="/settings/import">
                <Button variant="primary">Import CSV</Button>
              </Link>
              <Button onClick={() => setFormOpen(true)}>New account</Button>
            </div>
          }
        />
      ) : (
        <div className="space-y-9">
          {groups.map((g) => {
            const total = g.accounts.filter((a) => a.active).reduce((s, a) => s + a.current_balance, 0);
            return (
              <section key={g.type}>
                <div className="mb-1 flex items-baseline justify-between border-b border-line pb-2">
                  <h2 className="text-[17px] font-medium">{ACCOUNT_TYPES[g.type]}</h2>
                  <span className="tabular text-[14px] text-ink-2">
                    {isLiability(g.type) && total ? "-" : ""}
                    {formatMoney(total)}
                  </span>
                </div>
                <ul className="divide-y divide-line-soft">
                  {g.accounts.map((a) => (
                    <AccountRow key={a.id} account={a} />
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="text-[12.5px] text-ink-3">
            Balances are entered by you (CSV exports don&apos;t include them). Click a balance to update it; liabilities are entered as the amount owed.
          </p>
        </div>
      )}
      <AccountFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </Page>
  );
}

function AccountRow({ account: a }: { account: Account }) {
  const save = useSaveAccount();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = parseMoney(draft);
    setDraft(null);
    if (v === null || v === a.current_balance) return;
    save.mutate({ id: a.id, values: { current_balance: v, balance_as_of: todayISO() } });
  };
  const utilization = a.account_type === "credit_card" && a.credit_limit ? Math.min(100, (a.current_balance / a.credit_limit) * 100) : null;

  return (
    <li className={cn("flex items-center gap-4 py-2.5", !a.active && "opacity-55")}>
      <Link href={`/accounts/${a.id}`} className="min-w-0 flex-1 hover:underline">
        <span className="block truncate text-[14.5px] text-ink">
          {a.name}
          {a.last_four ? <span className="ml-1.5 text-ink-3">··{a.last_four}</span> : null}
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {[
            a.institution,
            a.plaid_item_id ? "Synced from bank" : null,
            a.balance_as_of ? `Updated ${formatMediumDate(a.balance_as_of)}` : "Balance not set",
            !a.active ? "Inactive" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </Link>
      {utilization !== null ? (
        <span
          className="hidden w-28 items-center gap-2 sm:flex"
          title={`${utilization.toFixed(0)}% of ${formatMoney(a.credit_limit!, { cents: false })} limit`}
        >
          <span className="h-1 flex-1 rounded-full bg-line-soft">
            <span className="block h-full rounded-full bg-slate" style={{ width: `${utilization}%` }} />
          </span>
          <span className="tabular text-[11.5px] text-ink-3">{utilization.toFixed(0)}%</span>
        </span>
      ) : null}
      <input
        aria-label={`Balance for ${a.name}`}
        inputMode="decimal"
        value={draft ?? a.current_balance.toFixed(2)}
        onFocus={(e) => {
          setDraft(a.current_balance.toFixed(2));
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="tabular h-8 w-32 rounded-md border border-transparent bg-transparent px-2 text-right text-[14.5px] hover:border-line focus:border-accent/60 focus:bg-surface focus:outline-none"
      />
    </li>
  );
}
