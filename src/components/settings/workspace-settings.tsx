"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Copy, LogOut, Trash2, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Page, PageHeader, SectionHeading } from "@/components/layout/app-shell";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { WorkspaceIcon } from "@/components/layout/workspace-switcher";
import { InlineText } from "@/components/transactions/inline-fields";
import { Button, IconButton } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getSupabase } from "@/lib/supabase/client";
import {
  inviteLink,
  useDeleteWorkspace,
  useInviteMember,
  useLeaveWorkspace,
  useRemoveMember,
  useRenameWorkspace,
  useRevokeInvite,
  useSetMemberRole,
  useWorkspaceInvites,
  useWorkspaceMembers,
} from "@/lib/queries/workspaces";
import { ROLE_HINTS, WORKSPACE_KINDS, WORKSPACE_ROLES, type WorkspaceRole } from "@/lib/workspace";

const ROLE_OPTIONS = (Object.keys(WORKSPACE_ROLES) as WorkspaceRole[]).map((r) => ({ value: r, label: WORKSPACE_ROLES[r] }));

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy. Select the link and copy it instead.");
  }
}

/** Name, members, invitations and deletion for the open workspace. */
export function WorkspaceSettings() {
  const { current, isOwner } = useWorkspace();
  const rename = useRenameWorkspace();
  const del = useDeleteWorkspace();
  const leave = useLeaveWorkspace();
  const confirm = useConfirm();
  const me = useQuery({ queryKey: ["me"], queryFn: async () => (await getSupabase().auth.getUser()).data.user });

  return (
    <Page>
      <p className="mb-2 text-[13px] text-ink-3">
        <Link href="/settings" className="hover:text-ink-2">
          Settings
        </Link>{" "}
        / Workspace
      </p>
      <PageHeader title="Workspace" subtitle="Everything in Ledger belongs to a workspace: accounts, transactions, categories, rules and recurring items." />

      <div className="space-y-12">
        <section>
          <SectionHeading>Details</SectionHeading>
          <dl className="grid grid-cols-[120px_1fr] items-center gap-y-3 text-sm">
            <dt className="text-ink-2">Name</dt>
            <dd>
              {isOwner ? (
                <InlineText
                  value={current.name}
                  ariaLabel="Workspace name"
                  maxLength={80}
                  onSave={(name) => name.trim() && name.trim() !== current.name && rename.mutate({ id: current.id, name: name.trim() })}
                />
              ) : (
                current.name
              )}
            </dd>
            <dt className="text-ink-2">Type</dt>
            <dd className="flex items-center gap-1.5">
              <WorkspaceIcon kind={current.kind} className="size-3.5 text-ink-3" /> {WORKSPACE_KINDS[current.kind]}
            </dd>
            <dt className="text-ink-2">Your role</dt>
            <dd>
              {WORKSPACE_ROLES[current.role]} <span className="text-ink-3">· {ROLE_HINTS[current.role]}</span>
            </dd>
          </dl>
        </section>

        <MembersSection meId={me.data?.id} />
        {isOwner ? <InvitesSection /> : null}

        <section>
          <SectionHeading>{isOwner ? "Danger zone" : "Leave"}</SectionHeading>
          {isOwner ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-brick/30 bg-brick-soft/40 px-4 py-3">
              <div>
                <p className="text-sm">Delete this workspace</p>
                <p className="text-[12.5px] text-ink-2">
                  Permanently deletes the workspace and everything in it, for every member. Bank connections stay yours.
                </p>
              </div>
              <Button
                variant="danger"
                disabled={del.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete ${current.name}?`,
                    body: "Every account, transaction, category, rule and recurring item in this workspace is deleted for everyone. This can't be undone.",
                    confirmLabel: "Delete workspace",
                    danger: true,
                    typeToConfirm: current.name,
                  });
                  if (ok) del.mutate({ id: current.id, confirmName: current.name });
                }}
              >
                <Trash2 /> Delete workspace
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3">
              <p className="text-sm text-ink-2">Leave {current.name}. You&apos;ll need a new invite to come back.</p>
              <Button
                disabled={leave.isPending}
                onClick={async () => {
                  if (await confirm({ title: `Leave ${current.name}?`, confirmLabel: "Leave", danger: true })) leave.mutate({ workspaceId: current.id });
                }}
              >
                <LogOut /> Leave workspace
              </Button>
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}

function MembersSection({ meId }: { meId?: string }) {
  const { current, isOwner } = useWorkspace();
  const members = useWorkspaceMembers(current.id);
  const setRole = useSetMemberRole(current.id);
  const remove = useRemoveMember(current.id);
  const confirm = useConfirm();

  return (
    <section>
      <SectionHeading>Members</SectionHeading>
      {members.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <ul className="divide-y divide-line-soft rounded-md border border-line bg-surface">
          {(members.data ?? []).map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {m.email}
                  {m.user_id === meId ? <span className="text-ink-3"> (you)</span> : null}
                </p>
                <p className="text-[12px] text-ink-3">Joined {formatDistanceToNowStrict(new Date(m.joined_at), { addSuffix: true })}</p>
              </div>
              {isOwner && m.user_id !== meId ? (
                <>
                  <Select
                    aria-label={`Role for ${m.email}`}
                    className="w-32"
                    value={m.role}
                    disabled={setRole.isPending}
                    onChange={(e) => setRole.mutate({ userId: m.user_id, role: e.target.value as WorkspaceRole })}
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <IconButton
                    label={`Remove ${m.email}`}
                    variant="quiet"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Remove ${m.email}?`,
                        body: "They lose access to this workspace. Anything they added stays. Their bank connections stop syncing into it.",
                        confirmLabel: "Remove",
                        danger: true,
                      });
                      if (ok) remove.mutate(m.user_id);
                    }}
                  >
                    <X />
                  </IconButton>
                </>
              ) : (
                <span className="text-[13px] text-ink-2">{WORKSPACE_ROLES[m.role]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ul className="mt-3 space-y-0.5 text-[12.5px] text-ink-3">
        {ROLE_OPTIONS.map((o) => (
          <li key={o.value}>
            <span className="text-ink-2">{o.label}:</span> {ROLE_HINTS[o.value]}
          </li>
        ))}
      </ul>
    </section>
  );
}

function InvitesSection() {
  const { current } = useWorkspace();
  const invites = useWorkspaceInvites(current.id, true);
  const invite = useInviteMember(current.id);
  const revoke = useRevokeInvite(current.id);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("editor");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    invite.mutate(
      { email: email.trim(), role },
      {
        onSuccess: (rows) => {
          setEmail("");
          if (rows[0]) copy(inviteLink(rows[0].token), "Invite link");
        },
        onError: (err) => setError((err as { message?: string }).message ?? "Could not invite."),
      },
    );
  };

  return (
    <section>
      <SectionHeading>Invite people</SectionHeading>
      <form onSubmit={submit} className="flex flex-wrap items-start gap-2">
        <Input
          type="email"
          aria-label="Email to invite"
          placeholder="name@example.com"
          className="min-w-0 flex-1 sm:max-w-xs"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Select aria-label="Role" className="w-32" value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
          {ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" disabled={!email.trim() || invite.isPending}>
          <UserPlus /> {invite.isPending ? "Inviting…" : "Invite"}
        </Button>
      </form>
      {error ? <p className="mt-2 text-[13px] text-brick">{error}</p> : null}
      <p className="mt-2 text-[12.5px] text-ink-3">
        Ledger doesn&apos;t send email: inviting copies a link for you to send. They sign in (or sign up) with that email address, then accept from the link or
        from the workspace menu.
      </p>

      {invites.data?.length ? (
        <ul className="mt-4 divide-y divide-line-soft rounded-md border border-line bg-surface">
          {invites.data.map((inv) => {
            const expired = new Date(inv.expires_at) < new Date();
            return (
              <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{inv.email}</p>
                  <p className="text-[12px] text-ink-3">
                    {WORKSPACE_ROLES[inv.role]} · {expired ? "expired" : `expires ${formatDistanceToNowStrict(new Date(inv.expires_at), { addSuffix: true })}`}
                  </p>
                </div>
                {expired ? null : (
                  <Button size="sm" onClick={() => copy(inviteLink(inv.token), "Invite link")}>
                    <Copy /> Copy link
                  </Button>
                )}
                <Button size="sm" variant="quiet" onClick={() => revoke.mutate(inv.id)}>
                  Revoke
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
