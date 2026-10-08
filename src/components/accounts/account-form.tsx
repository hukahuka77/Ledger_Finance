"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { WorkspaceChecks } from "@/components/accounts/workspace-checks";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { Checkbox, Switch } from "@/components/ui/checkbox";
import { Dialog, useConfirm } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { todayISO } from "@/lib/dates";
import { ACCOUNT_TYPE_OPTIONS, ACCOUNT_TYPE_SINGULAR, isLiability, type Account, type AccountType } from "@/lib/domain";
import { parseMoney } from "@/lib/money";
import { reportError } from "@/lib/errors";
import { useAccounts, useAllWorkspaceAccounts, useMoveAccountToWorkspace, useSaveAccount } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : v.toFixed(2));

export function AccountFormDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account?: Account }) {
  if (!open) return null;
  return <Inner key={account?.id ?? "new"} onOpenChange={onOpenChange} account={account} />;
}

function Inner({ onOpenChange, account }: { onOpenChange: (o: boolean) => void; account?: Account }) {
  const { data: accounts } = useAccounts();
  const save = useSaveAccount();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const { workspaces } = useWorkspace();
  const editable = workspaces.filter((w) => w.role !== "viewer");
  // Workspace placement: bank-synced accounts can be in several workspaces at once (each keeps syncing);
  // other accounts move as a whole.
  const placeable = Boolean(account) && editable.length > 1;
  const bankSynced = Boolean(account?.plaid_account_id);
  const { data: everyAccount } = useAllWorkspaceAccounts(placeable && bankSynced);
  const copies = account?.plaid_account_id ? (everyAccount ?? []).filter((a) => a.plaid_account_id === account.plaid_account_id) : [];
  const move = useMoveAccountToWorkspace();
  const [moveTo, setMoveTo] = useState(account?.workspace_id ?? "");
  const [f, setF] = useState({
    name: account?.name ?? "",
    institution: account?.institution ?? "",
    account_type: (account?.account_type ?? "checking") as AccountType,
    last_four: account?.last_four ?? "",
    currency: account?.currency ?? "USD",
    current_balance: num(account?.current_balance ?? 0),
    available_balance: num(account?.available_balance),
    credit_limit: num(account?.credit_limit),
    statement_balance: num(account?.statement_balance),
    minimum_payment: num(account?.minimum_payment),
    statement_close_day: account?.statement_close_day ? String(account.statement_close_day) : "",
    payment_due_day: account?.payment_due_day ? String(account.payment_due_day) : "",
    autopay_enabled: account?.autopay_enabled ?? false,
    autopay_account_id: account?.autopay_account_id ?? "",
    notes: account?.notes ?? "",
    active: account?.active ?? true,
    track_transactions: account?.track_transactions ?? true,
  });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const isCard = f.account_type === "credit_card";
  const liability = isLiability(f.account_type);

  const money = (s: string) => (s.trim() ? parseMoney(s) : null);
  const day = (s: string) => (s.trim() ? Number.parseInt(s, 10) : null);
  const errors: string[] = [];
  if (!f.name.trim()) errors.push("Name is required.");
  if (f.last_four && !/^[0-9A-Za-z]{1,8}$/.test(f.last_four)) errors.push("Last four should be letters or digits.");
  if (money(f.current_balance) === null) errors.push("Enter a current balance.");
  for (const [k, label] of [
    ["available_balance", "Available balance"],
    ["credit_limit", "Credit limit"],
    ["statement_balance", "Statement balance"],
    ["minimum_payment", "Minimum payment"],
  ] as const) {
    if (f[k].trim() && parseMoney(f[k]) === null) errors.push(`${label} is not a valid amount.`);
  }
  for (const [k, label] of [
    ["statement_close_day", "Statement day"],
    ["payment_due_day", "Due day"],
  ] as const) {
    const d = day(f[k]);
    if (f[k].trim() && (!Number.isInteger(d) || d! < 1 || d! > 31)) errors.push(`${label} must be 1–31.`);
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (errors.length) return;
    const balance = money(f.current_balance)!;
    const balanceChanged = !account || balance !== account.current_balance;
    save.mutate(
      {
        id: account?.id,
        values: {
          name: f.name.trim(),
          institution: f.institution.trim() || null,
          account_type: f.account_type,
          last_four: f.last_four.trim() || null,
          currency: f.currency.trim().toUpperCase() || "USD",
          current_balance: balance,
          available_balance: money(f.available_balance),
          balance_as_of: balanceChanged ? todayISO() : account?.balance_as_of,
          credit_limit: isCard ? money(f.credit_limit) : null,
          statement_balance: isCard ? money(f.statement_balance) : null,
          minimum_payment: isCard ? money(f.minimum_payment) : null,
          statement_close_day: isCard ? day(f.statement_close_day) : null,
          payment_due_day: liability ? day(f.payment_due_day) : null,
          autopay_enabled: liability ? f.autopay_enabled : false,
          autopay_account_id: liability && f.autopay_enabled && f.autopay_account_id ? f.autopay_account_id : null,
          notes: f.notes.trim() || null,
          active: f.active,
          track_transactions: f.track_transactions,
        },
      },
      {
        onSuccess: async (saved) => {
          onOpenChange(false);
          if (account?.track_transactions && !f.track_transactions) await offerToClear(saved.id, saved.name);
          if (account && moveTo && moveTo !== account.workspace_id) await moveAccount(saved);
        },
      },
    );
  };

  /** This account is gone from the open workspace: leave its page if we're on it. */
  const leaveIfOnPage = (id: string) => {
    if (pathname.startsWith(`/accounts/${id}`)) router.replace("/accounts");
  };

  const moveAccount = async (saved: Account) => {
    const target = workspaces.find((w) => w.id === moveTo);
    if (!target) return;
    const { count } = await getSupabase().from("transactions").select("id", { count: "exact", head: true }).eq("account_id", saved.id);
    const ok = await confirm({
      title: `Move ${saved.name} to ${target.name}?`,
      body: `${count ? `Its ${count.toLocaleString()} ${count === 1 ? "transaction moves" : "transactions move"} with it. ` : ""}Categories are matched by name in ${target.name}; transactions without a match are left uncategorized for review. Rules, tags and recurring links stay behind.`,
      confirmLabel: "Move account",
    });
    if (!ok) return;
    // The dialog has closed by now, so await rather than rely on mutate() callbacks.
    await move
      .mutateAsync({ accountId: saved.id, workspaceId: target.id, workspaceName: target.name })
      .then(() => leaveIfOnPage(saved.id))
      .catch(() => undefined);
  };

  /** Turning tracking off stops new imports; offer to remove what's already there. */
  const offerToClear = async (id: string, name: string) => {
    const { count } = await getSupabase().from("transactions").select("id", { count: "exact", head: true }).eq("account_id", id);
    if (!count) return;
    const ok = await confirm({
      title: `Delete the ${count.toLocaleString()} transactions already in ${name}?`,
      body: "Syncing won't import new ones for this account any more. Its balance keeps updating. Keep them if you still want them in the ledger.",
      confirmLabel: "Delete them",
      cancelLabel: "Keep them",
      danger: true,
    });
    if (!ok) return;
    const { error } = await getSupabase().from("transactions").delete().eq("account_id", id);
    if (error) return reportError(error, "Could not delete the transactions.");
    qc.invalidateQueries();
    toast.success(`Deleted ${count.toLocaleString()} transactions from ${name}`);
  };

  return (
    <Dialog open onOpenChange={onOpenChange} title={account ? "Edit account" : "New account"} className="max-w-2xl">
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="acct-name">
          <Input id="acct-name" value={f.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </Field>
        <Field label="Institution" htmlFor="acct-inst">
          <Input id="acct-inst" value={f.institution} maxLength={120} onChange={(e) => set({ institution: e.target.value })} />
        </Field>
        <Field label="Type" htmlFor="acct-type">
          <Select id="acct-type" value={f.account_type} onChange={(e) => set({ account_type: e.target.value as AccountType })}>
            {ACCOUNT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {ACCOUNT_TYPE_SINGULAR[o.value]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Last four" htmlFor="acct-last4">
            <Input id="acct-last4" value={f.last_four} maxLength={8} onChange={(e) => set({ last_four: e.target.value })} />
          </Field>
          <Field label="Currency" htmlFor="acct-cur">
            <Input id="acct-cur" value={f.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value })} />
          </Field>
        </div>
        <Field
          label={liability ? "Current balance owed" : "Current balance"}
          htmlFor="acct-bal"
          hint={liability ? "Enter the amount owed as a positive number." : undefined}
        >
          <Input id="acct-bal" inputMode="decimal" className="tabular" value={f.current_balance} onChange={(e) => set({ current_balance: e.target.value })} />
        </Field>
        <Field label={isCard ? "Available credit" : "Available balance"} htmlFor="acct-avail">
          <Input
            id="acct-avail"
            inputMode="decimal"
            className="tabular"
            value={f.available_balance}
            placeholder="Optional"
            onChange={(e) => set({ available_balance: e.target.value })}
          />
        </Field>

        {isCard ? (
          <>
            <Field label="Credit limit" htmlFor="acct-limit">
              <Input id="acct-limit" inputMode="decimal" className="tabular" value={f.credit_limit} onChange={(e) => set({ credit_limit: e.target.value })} />
            </Field>
            <Field label="Statement balance" htmlFor="acct-stmt">
              <Input
                id="acct-stmt"
                inputMode="decimal"
                className="tabular"
                value={f.statement_balance}
                onChange={(e) => set({ statement_balance: e.target.value })}
              />
            </Field>
            <Field label="Minimum payment" htmlFor="acct-min">
              <Input
                id="acct-min"
                inputMode="decimal"
                className="tabular"
                value={f.minimum_payment}
                onChange={(e) => set({ minimum_payment: e.target.value })}
              />
            </Field>
            <Field label="Statement closes on day" htmlFor="acct-close">
              <Input
                id="acct-close"
                inputMode="numeric"
                value={f.statement_close_day}
                placeholder="1–31"
                onChange={(e) => set({ statement_close_day: e.target.value })}
              />
            </Field>
          </>
        ) : null}
        {liability ? (
          <>
            <Field label="Payment due on day" htmlFor="acct-due" hint="Shown on the calendar each month.">
              <Input
                id="acct-due"
                inputMode="numeric"
                value={f.payment_due_day}
                placeholder="1–31"
                onChange={(e) => set({ payment_due_day: e.target.value })}
              />
            </Field>
            <div className="space-y-2">
              <label className="mt-6 flex items-center gap-2 text-sm text-ink-2">
                <Switch checked={f.autopay_enabled} onChange={(v) => set({ autopay_enabled: v })} label="Autopay" /> Autopay enabled
              </label>
              {f.autopay_enabled ? (
                <Select aria-label="Autopay from" value={f.autopay_account_id} onChange={(e) => set({ autopay_account_id: e.target.value })}>
                  <option value="">Paid from…</option>
                  {(accounts ?? [])
                    .filter((a) => a.id !== account?.id && !isLiability(a.account_type))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              ) : null}
            </div>
          </>
        ) : null}

        {placeable && account ? (
          bankSynced ? (
            <div className="sm:col-span-2">
              <p className="text-[13px] font-medium text-ink-2">Workspaces</p>
              <WorkspaceChecks
                copies={copies.length ? copies : [account]}
                onRemoved={(id) => {
                  if (id !== account.id) return;
                  onOpenChange(false);
                  leaveIfOnPage(id);
                }}
              />
              <p className="mt-1 text-[12.5px] text-ink-3">
                Each ticked workspace gets its own copy with the full history, and every sync updates all of them. Changes apply right away.
              </p>
            </div>
          ) : (
            <Field
              label="Workspace"
              htmlFor="acct-ws"
              className="sm:col-span-2"
              hint="Moving takes its transactions along. Categories are matched by name in the new workspace."
            >
              <Select id="acct-ws" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {editable.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )
        ) : null}
        <Field label="Notes" htmlFor="acct-notes" className="sm:col-span-2">
          <Textarea id="acct-notes" className="min-h-16" value={f.notes} maxLength={2000} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <div className="flex items-start gap-2.5 text-sm sm:col-span-2">
          <Checkbox
            className="mt-0.5"
            checked={f.track_transactions}
            onChange={(v) => set({ track_transactions: v })}
            label="Track transactions for this account"
          />
          <div>
            <p className="text-ink">Track transactions</p>
            <p className="text-[12.5px] text-ink-3">
              Import this account&apos;s transactions when syncing. Turn off to keep only its balance (for example, Coinbase or brokerage trades you don&apos;t
              want in the ledger).
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2 sm:col-span-2">
          <Switch checked={f.active} onChange={(v) => set({ active: v })} label="Active" /> Active (inactive accounts are hidden from the sidebar and balance
          totals)
        </label>
        {errors.length ? <p className="text-[12.5px] text-brick sm:col-span-2">{errors[0]}</p> : null}
        <div className="flex justify-end gap-2 border-t border-line-soft pt-4 sm:col-span-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={errors.length > 0 || save.isPending}>
            {save.isPending ? "Saving…" : !account ? "Create account" : moveTo && moveTo !== account.workspace_id ? "Save and move" : "Save account"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
