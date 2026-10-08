"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, Landmark, Trash2, Upload, Users, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Page, PageHeader, SectionHeading } from "@/components/layout/app-shell";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { InlineText } from "@/components/transactions/inline-fields";
import { Button, IconButton } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { reportError } from "@/lib/errors";
import { exportTransactions } from "@/lib/export";
import { DEFAULT_FILTERS } from "@/lib/filters";
import { unwrap, useAccountIndex, useCategoryIndex, useCreateTag, useDeleteTag, useTagIndex, useTags, useUpdateTag } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

const SHORTCUTS: [string, string][] = [
  ["↑ ↓ or J K", "Previous / next transaction"],
  ["R", "Toggle reviewed (advances to the next unreviewed)"],
  ["C", "Change category"],
  ["T", "Mark as transfer / undo"],
  ["X", "Select the current transaction"],
  ["/", "Search"],
  ["Esc", "Clear selection or close the detail pane"],
];

export function SettingsView() {
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const cats = useCategoryIndex();
  const accounts = useAccountIndex();
  const tags = useTagIndex();
  const [exporting, setExporting] = useState(false);
  const { current, isOwner } = useWorkspace();
  const user = useQuery({ queryKey: ["me"], queryFn: async () => (await getSupabase().auth.getUser()).data.user });

  const wipe = useMutation({
    mutationFn: async () => unwrap(getSupabase().rpc("delete_all_my_data", { p_confirm: "DELETE" })),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success(`All data in ${current.name} deleted`);
      router.push("/settings/import");
    },
    onError: (e) => reportError(e, "Could not delete data."),
  });

  const signOut = async () => {
    await getSupabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  return (
    <Page>
      <PageHeader title="Settings" />
      <div className="space-y-12">
        <section>
          <SectionHeading>Account</SectionHeading>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm">{user.data?.email ?? "…"}</p>
              <p className="text-[12.5px] text-ink-3">
                Your data lives in workspaces. Only their members can see it, enforced by row-level security in the database.
              </p>
            </div>
            <Button onClick={signOut}>Sign out</Button>
          </div>
        </section>

        <section>
          <SectionHeading>Workspace</SectionHeading>
          <ul className="divide-y divide-line-soft rounded-md border border-line bg-surface">
            <NavRow href="/settings/workspace" icon={<Users />} title={current.name} body="Name, members, roles and invitations." />
          </ul>
        </section>

        <section>
          <SectionHeading>Data in this workspace</SectionHeading>
          <ul className="divide-y divide-line-soft rounded-md border border-line bg-surface">
            <NavRow
              href="/settings/connections"
              icon={<Landmark />}
              title="Bank connections"
              body="Sync transactions and balances from your banks via Plaid."
            />
            <NavRow href="/settings/import" icon={<Upload />} title="Import CSV" body="Upload a bank or app export and review import history." />
            <NavRow href="/settings/rules" icon={<Wand2 />} title="Categorization rules" body="Automatically categorize, tag and mark recurring." />
            <li className="flex items-center gap-3 px-4 py-3">
              <Download className="size-4 text-ink-3" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">Export all transactions</p>
                <p className="text-[12.5px] text-ink-3">Download a CSV of every transaction in this workspace.</p>
              </div>
              <Button
                size="sm"
                disabled={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    const n = await exportTransactions(DEFAULT_FILTERS, cats, accounts, tags);
                    toast.success(`Exported ${n.toLocaleString()} transactions`);
                  } catch (e) {
                    reportError(e, "Could not export.");
                  } finally {
                    setExporting(false);
                  }
                }}
              >
                {exporting ? "Exporting…" : "Export"}
              </Button>
            </li>
          </ul>
        </section>

        <TagsSection />

        <section>
          <SectionHeading>Keyboard shortcuts</SectionHeading>
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>
                  <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink-2">{k}</kbd>
                </dt>
                <dd className="text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        {isOwner ? (
          <section>
            <SectionHeading>Danger zone</SectionHeading>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-brick/30 bg-brick-soft/40 px-4 py-3">
              <div>
                <p className="text-sm">Delete all data in {current.name}</p>
                <p className="text-[12.5px] text-ink-2">
                  Removes every account, transaction, category, rule, recurring item and import in this workspace. The workspace and its members remain.
                </p>
              </div>
              <Button
                variant="danger"
                disabled={wipe.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete all data in ${current.name}?`,
                    body: "This permanently deletes everything in this workspace, for every member. Export first if you want a copy.",
                    confirmLabel: "Delete everything",
                    danger: true,
                    typeToConfirm: "DELETE",
                  });
                  if (ok) wipe.mutate();
                }}
              >
                <Trash2 /> Delete all data
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </Page>
  );
}

function NavRow({ href, icon, title, body }: { href: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-3 px-4 py-3 hover:bg-hover/50 [&>svg]:size-4 [&>svg]:text-ink-3">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="text-sm">{title}</p>
          <p className="text-[12.5px] text-ink-3">{body}</p>
        </div>
        <ChevronRight className="size-4 text-ink-3" />
      </Link>
    </li>
  );
}

function TagsSection() {
  const { data: tags } = useTags();
  const create = useCreateTag();
  const update = useUpdateTag();
  const del = useDeleteTag();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  return (
    <section>
      <SectionHeading>Tags</SectionHeading>
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate(name, { onSuccess: () => setName("") });
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New tag, e.g. TaxDeductible"
          maxLength={50}
          className="max-w-xs"
          aria-label="New tag"
        />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          Add tag
        </Button>
      </form>
      {tags?.length ? (
        <ul className="divide-y divide-line-soft rounded-md border border-line bg-surface">
          {tags.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-4 py-1.5">
              <span className="text-ink-3">#</span>
              <div className="min-w-0 flex-1">
                <InlineText
                  ariaLabel="Tag name"
                  value={t.name}
                  required
                  maxLength={50}
                  onSave={(v) => update.mutate({ id: t.id, values: { name: v.replace(/^#/, "") } })}
                  className="text-sm"
                />
              </div>
              <Link href={`/transactions?tag=${t.id}`} className="text-[12.5px] text-ink-2 hover:text-ink">
                Transactions
              </Link>
              <IconButton
                label={`Delete tag ${t.name}`}
                size="sm"
                variant="quiet"
                onClick={async () => {
                  if (await confirm({ title: `Delete #${t.name}?`, body: "It will be removed from all transactions.", confirmLabel: "Delete", danger: true }))
                    del.mutate(t.id);
                }}
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-3">No tags yet. Tags let you group transactions across categories, like #Vacation or #TaxDeductible.</p>
      )}
    </section>
  );
}
