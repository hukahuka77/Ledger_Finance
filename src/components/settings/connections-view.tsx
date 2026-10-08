"use client";

import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, Landmark, Link2, Plus, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from "react-plaid-link";
import { Page, PageHeader, SectionHeading } from "@/components/layout/app-shell";
import { WorkspaceChecks } from "@/components/accounts/workspace-checks";
import { CoinbaseSection } from "@/components/settings/coinbase-section";
import { Button } from "@/components/ui/button";
import { Dialog, useConfirm } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMediumDate } from "@/lib/dates";
import { ACCOUNT_TYPE_OPTIONS, ACCOUNT_TYPE_SINGULAR, type Account } from "@/lib/domain";
import { reportError } from "@/lib/errors";
import { mapAccountType, suggestAccountMatch, type PlaidAccountSnapshot } from "@/lib/plaid/mapping";
import {
  createLinkToken,
  exchangePublicToken,
  useLinkAccounts,
  usePlaidItems,
  usePlaidStatus,
  useRemoveItem,
  useSyncNow,
  type AccountMapping,
  type PlaidItemView,
} from "@/lib/queries/plaid";
import { useCoinbaseConnections } from "@/lib/queries/coinbase";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { useAllWorkspaceAccounts } from "@/lib/queries/reference";
import { WORKSPACE_HEADER } from "@/lib/workspace";
import { getSupabase } from "@/lib/supabase/client";

/** Opens Plaid Link as soon as it's ready, then reports back. */
function PlaidLauncher({
  token,
  onSuccess,
  onDone,
}: {
  token: string;
  onSuccess: (publicToken: string | null, meta: PlaidLinkOnSuccessMetadata) => void;
  onDone: () => void;
}) {
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken, meta) => {
      onSuccess(publicToken, meta);
      onDone();
    },
    onExit: () => onDone(),
  });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}

type Mapping = { item: { id: string; institution_name: string | null }; accounts: PlaidAccountSnapshot[] };

export function ConnectionsView() {
  const status = usePlaidStatus();
  const items = usePlaidItems();
  const coinbase = useCoinbaseConnections();
  const { data: accounts } = useAllWorkspaceAccounts();
  const sync = useSyncNow();
  const remove = useRemoveItem();
  const confirm = useConfirm();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [mapping, setMapping] = useState<Mapping | null>(null);

  const startLink = async (itemId?: string) => {
    setStarting(true);
    try {
      const { linkToken } = await createLinkToken(itemId);
      setLinkToken(linkToken);
    } catch (e) {
      reportError(e, "Could not start the bank connection.");
      setStarting(false);
    }
  };

  const onLinkSuccess = async (publicToken: string | null, meta: PlaidLinkOnSuccessMetadata, isUpdate: boolean) => {
    if (isUpdate || !publicToken) {
      // Update mode re-authenticates an existing item; no new token to exchange.
      sync.mutate(undefined);
      return;
    }
    try {
      const res = await exchangePublicToken(publicToken, { id: meta.institution?.institution_id ?? null, name: meta.institution?.name ?? null });
      setMapping(res);
      items.refetch();
    } catch (e) {
      reportError(e, "Could not finish connecting the bank.");
    }
  };

  const [updateItemId, setUpdateItemId] = useState<string | null>(null);
  const configured = status.data?.configured;

  return (
    <Page>
      <p className="mb-2 text-[13px] text-ink-3">
        <Link href="/settings" className="hover:text-ink-2">
          Settings
        </Link>{" "}
        / Bank connections
      </p>
      <PageHeader
        title="Bank connections"
        subtitle="Connect accounts through Plaid to pull transactions and balances automatically. Your bank login happens inside Plaid; this app never sees it."
        actions={
          configured ? (
            <>
              <Button disabled={!(items.data?.length || coinbase.data?.length) || sync.isPending} onClick={() => sync.mutate(undefined)}>
                <RefreshCw className={cn(sync.isPending && "animate-spin")} /> {sync.isPending ? "Syncing…" : "Sync all"}
              </Button>
              <Button
                variant="primary"
                disabled={starting}
                onClick={() => {
                  setUpdateItemId(null);
                  startLink();
                }}
              >
                <Plus /> {starting ? "Opening…" : "Connect a bank"}
              </Button>
            </>
          ) : undefined
        }
      />

      {status.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !configured ? (
        <div className="rounded-lg border border-line bg-surface p-5 text-sm">
          <p className="font-medium">Bank connections aren&apos;t set up on the server yet.</p>
          <p className="mt-1 text-ink-2">
            Add <code className="font-mono text-[12.5px]">PLAID_CLIENT_ID</code>, <code className="font-mono text-[12.5px]">PLAID_SECRET</code>,{" "}
            <code className="font-mono text-[12.5px]">PLAID_ENV</code> and <code className="font-mono text-[12.5px]">PLAID_TOKEN_KEY</code> to the
            deployment&apos;s environment variables, then redeploy.
          </p>
        </div>
      ) : (
        <>
          {status.data?.environment === "sandbox" ? (
            <p className="mb-4 rounded-md border border-ochre/40 bg-[#f5ecd8] px-3 py-2 text-[13px] text-ink-2">
              Sandbox mode: only Plaid&apos;s test banks work (username <code className="font-mono">user_good</code>, password{" "}
              <code className="font-mono">pass_good</code>). Switch <code className="font-mono">PLAID_ENV</code> to{" "}
              <code className="font-mono">production</code> to connect your real accounts.
            </p>
          ) : null}
          {!status.data?.backgroundSync ? (
            <p className="mb-4 text-[12.5px] text-ink-3">
              Syncs run when you open the app or press Sync. Automatic background sync turns on once the server has its service key.
            </p>
          ) : null}

          {items.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !items.data?.length ? (
            <EmptyState
              title="No banks connected."
              body="Connect a bank to pull new transactions and current balances automatically. Accounts you can't connect (like Apple Card) keep working through CSV import."
              action={
                <Button variant="primary" onClick={() => startLink()} disabled={starting}>
                  <Landmark /> Connect a bank
                </Button>
              }
            />
          ) : (
            <div className="space-y-5">
              {items.data.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  accounts={(accounts ?? []).filter((a) => a.plaid_item_id === item.id)}
                  syncing={sync.isPending && sync.variables === item.id}
                  onSync={() => sync.mutate(item.id)}
                  onEdit={() => setMapping({ item: { id: item.id, institution_name: item.institution_name }, accounts: item.plaid_accounts })}
                  onReconnect={() => {
                    setUpdateItemId(item.id);
                    startLink(item.id);
                  }}
                  onRemove={async () => {
                    const ok = await confirm({
                      title: `Disconnect ${item.institution_name ?? "this bank"}?`,
                      body: "Syncing stops and access at Plaid is revoked. Your accounts and all transactions stay in the ledger.",
                      confirmLabel: "Disconnect",
                      danger: true,
                    });
                    if (ok) remove.mutate(item.id);
                  }}
                />
              ))}
            </div>
          )}

          <SectionHeading className="mt-12">How it works</SectionHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-[13.5px] text-ink-2">
            <li>New transactions arrive unreviewed, run through your categorization rules, and land in the review queue.</li>
            <li>Pending charges update in place when they post; charges the bank cancels are removed.</li>
            <li>
              When linking an account that already has CSV history, choose a start date. Overlapping charges are matched to what you already have instead of
              being duplicated.
            </li>
            <li>Balances update from the bank on every sync.</li>
            <li>
              For credit cards, the statement balance, minimum payment, due date and statement close date also update on every sync, and the due date appears on
              the calendar with the statement balance.
            </li>
          </ul>
        </>
      )}

      {status.data?.coinbase ? <CoinbaseSection /> : null}

      {linkToken ? (
        <PlaidLauncher
          token={linkToken}
          onSuccess={(pt, meta) => onLinkSuccess(pt, meta, Boolean(updateItemId))}
          onDone={() => {
            setLinkToken(null);
            setStarting(false);
          }}
        />
      ) : null}
      <MappingDialog mapping={mapping} onClose={() => setMapping(null)} />
    </Page>
  );
}

function ItemCard({
  item,
  accounts,
  syncing,
  onSync,
  onEdit,
  onReconnect,
  onRemove,
}: {
  item: PlaidItemView;
  accounts: Account[];
  syncing: boolean;
  onSync: () => void;
  onEdit: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const needsLogin = item.status === "login_required";
  const { workspaces, current } = useWorkspace();
  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        <Landmark className="size-5 text-ink-3" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{item.institution_name ?? "Bank"}</p>
          <p className={cn("flex items-center gap-1.5 text-[12.5px]", needsLogin || item.status === "error" ? "text-brick" : "text-ink-3")}>
            {needsLogin ? (
              <AlertTriangle className="size-3.5" />
            ) : item.status === "error" ? (
              <AlertTriangle className="size-3.5" />
            ) : (
              <CheckCircle2 className="size-3.5 text-sage" />
            )}
            {needsLogin
              ? "Sign-in needed to keep syncing"
              : item.status === "error"
                ? (item.last_sync_error ?? "Last sync failed")
                : item.last_synced_at
                  ? `Synced ${formatDistanceToNow(new Date(item.last_synced_at), { addSuffix: true })}`
                  : "Not synced yet"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {needsLogin ? (
            <Button size="sm" variant="primary" onClick={onReconnect}>
              <Link2 /> Reconnect
            </Button>
          ) : (
            <Button size="sm" onClick={onSync} disabled={syncing}>
              <RefreshCw className={cn(syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync now"}
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={onEdit}>
            Edit accounts
          </Button>
          <Button size="sm" variant="quiet" onClick={onRemove}>
            <Unplug /> Disconnect
          </Button>
        </div>
      </div>
      {item.liabilities_status === "consent_required" && !needsLogin ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-[#f5ecd8]/60 px-4 py-2.5 text-[13px] text-ink-2">
          <span className="min-w-0 flex-1">
            To pull card statement balances and due dates, {item.institution_name ?? "this bank"} needs a one-time permission. You won&apos;t re-enter your
            password unless the bank asks.
          </span>
          <Button size="sm" variant="primary" onClick={onReconnect}>
            <Link2 /> Allow statements
          </Button>
        </div>
      ) : item.liabilities_status === "not_enabled" ? (
        <p className="border-b border-line-soft px-4 py-2.5 text-[13px] text-ink-3">
          Card statements are off: Liabilities isn&apos;t enabled for this app in the Plaid Dashboard.
        </p>
      ) : null}
      <ul className="divide-y divide-line-soft">
        {item.plaid_accounts.map((pa) => {
          const copies = accounts.filter((a) => a.plaid_account_id === pa.account_id);
          const linked = copies.find((a) => a.workspace_id === current.id) ?? copies[0];
          const elsewhere = linked && linked.workspace_id !== current.id ? workspaces.find((w) => w.id === linked.workspace_id) : undefined;
          return (
            <li key={pa.account_id} className="px-4 py-2 text-[13.5px]">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate">
                  {pa.name}
                  {pa.mask ? <span className="text-ink-3"> ··{pa.mask}</span> : null}
                </span>
                {linked ? (
                  elsewhere ? (
                    <span className="truncate text-ink-2">
                      → {linked.name} <span className="text-ink-3">in {elsewhere.name}</span>
                    </span>
                  ) : (
                    <Link href={`/accounts/${linked.id}`} className="truncate text-ink-2 hover:text-ink hover:underline">
                      → {linked.name}
                      {linked.sync_from ? <span className="text-ink-3"> · from {formatMediumDate(linked.sync_from)}</span> : null}
                    </Link>
                  )
                ) : (
                  <span className="text-ink-3">Not synced</span>
                )}
              </div>
              {workspaces.length > 1 && linked ? <WorkspaceChecks copies={copies} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type Row = {
  pa: PlaidAccountSnapshot;
  /** The ledger account this row was linked to when the dialog opened. */
  linkedId: string | null;
  choice: string;
  name: string;
  accountType: string;
  syncFrom: string;
  workspaceId: string;
};

async function latestDate(accountId: string): Promise<string> {
  const { data } = await getSupabase()
    .from("transactions")
    .select("transaction_date")
    .eq("account_id", accountId)
    .order("transaction_date", { ascending: false })
    .limit(1)
    .setHeader(WORKSPACE_HEADER, "all");
  return data?.[0]?.transaction_date ?? "";
}

function MappingDialog({ mapping, onClose }: { mapping: Mapping | null; onClose: () => void }) {
  if (!mapping) return null;
  return <MappingDialogInner key={mapping.item.id} mapping={mapping} onClose={onClose} />;
}

function MappingDialogInner({ mapping, onClose }: { mapping: Mapping; onClose: () => void }) {
  const { workspaces, current } = useWorkspace();
  const editable = workspaces.filter((w) => w.role !== "viewer");
  const { data: allAccounts } = useAllWorkspaceAccounts();
  const accounts = (allAccounts ?? []).filter((a) => editable.some((w) => w.id === a.workspace_id));
  const link = useLinkAccounts();
  const [rows, setRows] = useState<Row[]>(() =>
    mapping.accounts.map((pa) => {
      // Keep the current link (this workspace's copy first); otherwise suggest matches in the open workspace first.
      const copies = accounts.filter((a) => a.plaid_account_id === pa.account_id);
      const linked = copies.find((a) => a.workspace_id === current.id) ?? copies[0];
      const match =
        linked ??
        suggestAccountMatch(
          pa,
          accounts.filter((a) => a.workspace_id === current.id),
        ) ??
        suggestAccountMatch(pa, accounts);
      return {
        pa,
        linkedId: linked?.id ?? null,
        choice: match ? match.id : "__new",
        name: pa.name,
        accountType: mapAccountType(pa.type, pa.subtype),
        syncFrom: match?.sync_from ?? "",
        workspaceId: current.id,
      };
    }),
  );

  // Default the start date for existing accounts to their latest transaction (overlap is de-duplicated).
  useEffect(() => {
    rows.forEach((r, i) => {
      if (r.choice.startsWith("__") || r.syncFrom) return;
      latestDate(r.choice).then((d) => d && setRows((rs) => rs.map((x, j) => (j === i && !x.syncFrom ? { ...x, syncFrom: d } : x))));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial defaults only
  }, []);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => !r.choice.startsWith("__")).map((r) => r.choice);
  const duplicateTarget = chosen.length !== new Set(chosen).size;
  const invalid = duplicateTarget || rows.some((r) => r.choice === "__new" && !r.name.trim());

  const submit = () => {
    const mappings: AccountMapping[] = rows.map((r) =>
      r.choice === "__skip"
        ? { action: "skip", plaidAccountId: r.pa.account_id }
        : r.choice === "__new"
          ? {
              action: "new",
              plaidAccountId: r.pa.account_id,
              name: r.name.trim(),
              accountType: r.accountType,
              workspaceId: r.workspaceId,
              replaces: r.linkedId,
            }
          : { action: "existing", plaidAccountId: r.pa.account_id, accountId: r.choice, syncFrom: r.syncFrom || null, replaces: r.linkedId },
    );
    link.mutate({ itemId: mapping.item.id, mappings }, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !link.isPending && onClose()}
      title={`Link ${mapping.item.institution_name ?? "bank"} accounts`}
      description="Match each bank account to an account in your ledger, create a new one, or leave it out."
      className="max-w-3xl"
      footer={
        <>
          <Button onClick={onClose} disabled={link.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={invalid || link.isPending}>
            {link.isPending ? "Linking and syncing…" : "Link and sync"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {rows.map((r, i) => (
          <div key={r.pa.account_id} className="rounded-md border border-line bg-surface p-3">
            <p className="text-sm font-medium">
              {r.pa.name}
              {r.pa.mask ? <span className="font-normal text-ink-3"> ··{r.pa.mask}</span> : null}
              <span className="ml-2 text-[12px] font-normal text-ink-3">{ACCOUNT_TYPE_SINGULAR[mapAccountType(r.pa.type, r.pa.subtype)]}</span>
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1.2fr_1fr]">
              <Select
                aria-label={`Ledger account for ${r.pa.name}`}
                value={r.choice}
                onChange={async (e) => {
                  const v = e.target.value;
                  set(i, { choice: v, syncFrom: "" });
                  if (!v.startsWith("__")) {
                    const d = await latestDate(v);
                    set(i, { syncFrom: d });
                  }
                }}
              >
                <option value="__new">Create a new account</option>
                <option value="__skip">Don&apos;t sync this account</option>
                {editable.map((w) => {
                  const inWorkspace = accounts.filter((a) => a.workspace_id === w.id);
                  return inWorkspace.length ? (
                    <optgroup key={w.id} label={editable.length > 1 ? `Link to existing account in ${w.name}` : "Link to existing account"}>
                      {inWorkspace.map((a) => (
                        <option key={a.id} value={a.id} disabled={Boolean(a.plaid_account_id && a.plaid_account_id !== r.pa.account_id)}>
                          {a.name}
                          {a.last_four ? ` ··${a.last_four}` : ""}
                          {a.plaid_account_id && a.plaid_account_id !== r.pa.account_id ? " (linked elsewhere)" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </Select>
              {r.choice === "__new" ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_140px] gap-2">
                    <Input aria-label="New account name" value={r.name} maxLength={120} onChange={(e) => set(i, { name: e.target.value })} />
                    <Select aria-label="Account type" value={r.accountType} onChange={(e) => set(i, { accountType: e.target.value })}>
                      {ACCOUNT_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {ACCOUNT_TYPE_SINGULAR[o.value]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {editable.length > 1 ? (
                    <Select aria-label="Workspace for the new account" value={r.workspaceId} onChange={(e) => set(i, { workspaceId: e.target.value })}>
                      {editable.map((w) => (
                        <option key={w.id} value={w.id}>
                          In {w.name}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                </div>
              ) : r.choice === "__skip" ? (
                <p className="self-center text-[12.5px] text-ink-3">Transactions from this account will be ignored.</p>
              ) : (
                <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                  Import from
                  <Input
                    type="date"
                    className="w-40"
                    aria-label="Import transactions from"
                    value={r.syncFrom}
                    onChange={(e) => set(i, { syncFrom: e.target.value })}
                  />
                </label>
              )}
            </div>
            {r.choice !== "__new" && r.choice !== "__skip" ? (
              <p className="mt-1.5 text-[12px] text-ink-3">
                {r.syncFrom
                  ? `Earlier bank history is skipped. Charges on or near ${formatMediumDate(r.syncFrom)} that you already have are matched, not duplicated.`
                  : "All available bank history (up to 2 years) will be imported and matched against what you already have."}
              </p>
            ) : null}
          </div>
        ))}
        {duplicateTarget ? <p className="text-sm text-brick">Two bank accounts point at the same ledger account.</p> : null}
      </div>
    </Dialog>
  );
}
