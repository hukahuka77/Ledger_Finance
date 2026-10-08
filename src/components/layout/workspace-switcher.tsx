"use client";

import { Briefcase, Check, ChevronsUpDown, Mail, Plus, Settings2, User } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { openWorkspace, useAcceptInvite, useCreateWorkspace, useMyInvites } from "@/lib/queries/workspaces";
import { WORKSPACE_KINDS, WORKSPACE_ROLES, type WorkspaceKind } from "@/lib/workspace";

export const WorkspaceIcon = ({ kind, className }: { kind: WorkspaceKind; className?: string }) =>
  kind === "business" ? <Briefcase className={className} strokeWidth={1.75} /> : <User className={className} strokeWidth={1.75} />;

/** Workspace dropdown at the top of the sidebar: switch, create, accept invitations. */
export function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { workspaces, current } = useWorkspace();
  const invites = useMyInvites();
  const accept = useAcceptInvite();
  const [creating, setCreating] = useState(false);
  const pending = invites.data ?? [];

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="flex h-10 w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 text-left hover:bg-hover"
            aria-label={`Workspace: ${current.name}. Switch workspace`}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded bg-selected text-ink-2">
              <WorkspaceIcon kind={current.kind} className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] leading-tight font-medium text-ink">{current.name}</span>
              <span className="block text-[11px] leading-tight text-ink-3">
                {WORKSPACE_KINDS[current.kind]}
                {current.role !== "owner" ? ` · ${WORKSPACE_ROLES[current.role]}` : ""}
              </span>
            </span>
            {pending.length ? <span className="size-2 shrink-0 rounded-full bg-accent" aria-label={`${pending.length} invitations`} /> : null}
            <ChevronsUpDown className="size-4 shrink-0 text-ink-3" />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-[260px]">
          <MenuLabel>Workspaces</MenuLabel>
          {workspaces.map((w) => (
            <MenuItem key={w.id} onSelect={() => w.id !== current.id && openWorkspace(w.id)}>
              <WorkspaceIcon kind={w.kind} />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.id === current.id ? <Check className="!text-accent" /> : null}
            </MenuItem>
          ))}
          {pending.length ? (
            <>
              <MenuSeparator />
              <MenuLabel>Invitations</MenuLabel>
              {pending.map((inv) => (
                <MenuItem key={inv.id} onSelect={() => accept.mutate(inv.token)} title={`Invited by ${inv.invited_by_email ?? "someone"} as ${inv.role}`}>
                  <Mail />
                  <span className="min-w-0 flex-1 truncate">Join {inv.workspace_name}</span>
                  <span className="text-[11px] text-ink-3">{WORKSPACE_ROLES[inv.role]}</span>
                </MenuItem>
              ))}
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem onSelect={() => setCreating(true)}>
            <Plus /> New workspace
          </MenuItem>
          <MenuItem asChild>
            <Link href="/settings/workspace" onClick={onNavigate}>
              <Settings2 /> Workspace settings
            </Link>
          </MenuItem>
        </MenuContent>
      </Menu>
      {creating ? <CreateWorkspaceDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateWorkspace();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<WorkspaceKind>("business");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !create.isPending && onClose()}
      title="New workspace"
      description="A workspace has its own accounts, transactions, categories, rules and people. Switch between them from the top of the sidebar."
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate({ name: name.trim(), kind })}>
            {create.isPending ? "Creating…" : "Create workspace"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ name: name.trim(), kind });
        }}
      >
        <Field label="Name" htmlFor="ws-name">
          <Input id="ws-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Consulting LLC" />
        </Field>
        <div>
          <p className="mb-1 text-[12px] font-medium tracking-wide text-ink-2">Type</p>
          <Segmented
            ariaLabel="Workspace type"
            value={kind}
            onChange={(v) => setKind(v as WorkspaceKind)}
            options={[
              { value: "business", label: "Business" },
              { value: "personal", label: "Personal" },
            ]}
          />
          <p className={cn("mt-2 text-[12.5px] text-ink-3")}>
            {kind === "business"
              ? "Starts with a chart of accounts (revenue, cost of goods, expenses with Schedule C lines, owner's equity) and a business dashboard: revenue, profit, margin and cash."
              : "Starts with everyday spending categories and the personal dashboard: net worth, spending and income."}
          </p>
        </div>
      </form>
    </Dialog>
  );
}
