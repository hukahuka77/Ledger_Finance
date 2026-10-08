"use client";

import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, Coins, ExternalLink, KeyRound, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { SectionHeading } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, useConfirm } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { totalUsd } from "@/lib/coinbase/mapping";
import { formatMoney } from "@/lib/money";
import { useCoinbaseConnections, useConnectCoinbase, useRemoveCoinbase, type CoinbaseConnectionView } from "@/lib/queries/coinbase";
import { useSyncNow } from "@/lib/queries/plaid";
import { useAccounts } from "@/lib/queries/reference";

const CDP_KEYS_URL = "https://portal.cdp.coinbase.com/projects/api-keys";

/** Coinbase connected with a read-only (View) CDP API key. */
export function CoinbaseSection() {
  const conns = useCoinbaseConnections();
  const sync = useSyncNow();
  const remove = useRemoveCoinbase();
  const confirm = useConfirm();
  const [form, setForm] = useState<{ keyName: string; accountId: string | null } | null>(null);

  return (
    <>
      <SectionHeading
        className="mt-12"
        actions={
          conns.data?.length ? null : (
            <Button size="sm" variant="primary" onClick={() => setForm({ keyName: "", accountId: null })}>
              <Coins /> Connect Coinbase
            </Button>
          )
        }
      >
        Coinbase
      </SectionHeading>
      {conns.isLoading ? null : !conns.data?.length ? (
        <p className="text-[13.5px] text-ink-2">
          Pull your Coinbase balances, buys, sells, sends, staking rewards and Coinbase Card spending with a view-only API key. The key can&apos;t trade or move
          money.
        </p>
      ) : (
        <div className="space-y-5">
          {conns.data.map((c) => (
            <CoinbaseCard
              key={c.id}
              conn={c}
              syncing={sync.isPending && sync.variables === c.id}
              onSync={() => sync.mutate(c.id)}
              onReplace={() => setForm({ keyName: c.key_name, accountId: c.account_id })}
              onRemove={async () => {
                const ok = await confirm({
                  title: "Disconnect Coinbase?",
                  body: "Syncing stops and the key is deleted from Ledger. Your Coinbase account and its transactions stay. To revoke the key itself, delete it in the Coinbase Developer Platform.",
                  confirmLabel: "Disconnect",
                  danger: true,
                });
                if (ok) remove.mutate(c.id);
              }}
            />
          ))}
        </div>
      )}
      {form ? <ConnectDialog initial={form} onClose={() => setForm(null)} /> : null}
    </>
  );
}

function CoinbaseCard({
  conn,
  syncing,
  onSync,
  onReplace,
  onRemove,
}: {
  conn: CoinbaseConnectionView;
  syncing: boolean;
  onSync: () => void;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const { data: accounts } = useAccounts();
  const account = accounts?.find((a) => a.id === conn.account_id);
  const held = conn.wallets.filter((w) => w.balance !== 0).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const bad = conn.status !== "active";
  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        <Coins className="size-5 text-ink-3" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">
            Coinbase
            {account ? (
              <Link href={`/accounts/${account.id}`} className="ml-2 text-[13px] font-normal text-ink-2 hover:text-ink hover:underline">
                → {account.name}
              </Link>
            ) : null}
          </p>
          <p className={cn("flex items-center gap-1.5 text-[12.5px]", bad ? "text-brick" : "text-ink-3")}>
            {bad ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5 text-sage" />}
            {bad
              ? (conn.last_sync_error ?? "Last sync failed")
              : conn.last_synced_at
                ? `Synced ${formatDistanceToNow(new Date(conn.last_synced_at), { addSuffix: true })}`
                : "Not synced yet"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {conn.status === "auth_failed" ? (
            <Button size="sm" variant="primary" onClick={onReplace}>
              <KeyRound /> Replace key
            </Button>
          ) : (
            <Button size="sm" onClick={onSync} disabled={syncing}>
              <RefreshCw className={cn(syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync now"}
            </Button>
          )}
          {conn.status === "auth_failed" ? null : (
            <Button size="sm" variant="quiet" onClick={onReplace}>
              <KeyRound /> Replace key
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={onRemove}>
            <Unplug /> Disconnect
          </Button>
        </div>
      </div>
      {held.length ? (
        <ul className="divide-y divide-line-soft">
          {held.map((w) => (
            <li key={w.id} className="flex items-center gap-3 px-4 py-2 text-[13.5px]">
              <span className="min-w-0 flex-1 truncate">
                {w.name}
                <span className="text-ink-3">
                  {" "}
                  · {w.balance.toLocaleString("en-US", { maximumFractionDigits: 8 })} {w.currency}
                </span>
              </span>
              <span className="tabular-nums text-ink-2">{w.usd === null ? "—" : formatMoney(w.usd, { cents: true })}</span>
            </li>
          ))}
          <li className="flex items-center gap-3 px-4 py-2 text-[13.5px] font-medium">
            <span className="flex-1">Total</span>
            <span className="tabular-nums">{formatMoney(totalUsd(held), { cents: true })}</span>
          </li>
        </ul>
      ) : (
        <p className="px-4 py-3 text-[13px] text-ink-3">{conn.last_synced_at ? "No balances held." : "Balances appear after the first sync."}</p>
      )}
    </section>
  );
}

function ConnectDialog({ initial, onClose }: { initial: { keyName: string; accountId: string | null }; onClose: () => void }) {
  const { data: accounts } = useAccounts();
  const connect = useConnectCoinbase();
  const replacing = Boolean(initial.keyName);
  const [keyName, setKeyName] = useState(initial.keyName);
  const [privateKey, setPrivateKey] = useState("");
  const [accountId, setAccountId] = useState(initial.accountId ?? "__new");
  const [error, setError] = useState<string | null>(null);
  const options = (accounts ?? []).filter((a) => a.active).sort((a, b) => Number(b.account_type === "brokerage") - Number(a.account_type === "brokerage"));

  const submit = () => {
    setError(null);
    connect.mutate(
      { keyName: keyName.trim(), privateKey, accountId: accountId === "__new" ? null : accountId },
      { onSuccess: onClose, onError: (e) => setError(e.message || "Could not connect.") },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !connect.isPending && onClose()}
      title={replacing ? "Replace Coinbase key" : "Connect Coinbase"}
      description="Ledger only needs to read your account, so the key gets View permission and nothing else."
      className="max-w-xl"
      footer={
        <>
          <Button onClick={onClose} disabled={connect.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={connect.isPending || !keyName.trim() || !privateKey.trim()}>
            {connect.isPending ? "Checking and syncing…" : "Connect and sync"}
          </Button>
        </>
      }
    >
      <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-[13px] text-ink-2">
        <li>
          Open{" "}
          <a href={CDP_KEYS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink underline">
            Coinbase Developer Platform → API keys <ExternalLink className="size-3" />
          </a>{" "}
          and sign in with your Coinbase account.
        </li>
        <li>
          Choose <b>Create API key</b> and name it &quot;Ledger&quot;. Under API restrictions, tick <b>View</b> only. Leave Trade and Transfer off.
        </li>
        <li>
          Open <b>Advanced settings</b> and set the signature algorithm to <b>ECDSA</b>. Ed25519 keys don&apos;t work with Coinbase&apos;s account API.
        </li>
        <li>Create the key, then copy the API key name and private key below. Coinbase only shows the private key once.</li>
      </ol>
      <div className="space-y-4">
        <Field label="API key name" htmlFor="cb-key-name" hint="Looks like organizations/…/apiKeys/…">
          <Input
            id="cb-key-name"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="organizations/…/apiKeys/…"
            autoComplete="off"
            spellCheck={false}
            readOnly={replacing}
          />
        </Field>
        <Field label="Private key" htmlFor="cb-private-key" hint="Stored encrypted. It never goes back to your browser.">
          <Textarea
            id="cb-private-key"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            placeholder={"-----BEGIN EC PRIVATE KEY-----\n…\n-----END EC PRIVATE KEY-----"}
            rows={5}
            className="font-mono text-[12px]"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Ledger account" htmlFor="cb-account" hint="All your Coinbase wallets roll up into this one account, valued in USD.">
          <Select id="cb-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="__new">Create an account named &quot;Coinbase&quot;</option>
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {error ? (
          <p role="alert" className="flex items-start gap-1.5 rounded-md border border-brick/30 bg-[#f7e9e4] px-3 py-2 text-[13px] text-brick">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
