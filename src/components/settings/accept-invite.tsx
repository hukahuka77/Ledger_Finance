"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Page } from "@/components/layout/app-shell";
import { WorkspaceIcon } from "@/components/layout/workspace-switcher";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getSupabase } from "@/lib/supabase/client";
import { useAcceptInvite, useMyInvites } from "@/lib/queries/workspaces";
import { WORKSPACE_KINDS, WORKSPACE_ROLES } from "@/lib/workspace";

/** Landing page for an invite link: shows the invitation addressed to this login and accepts it. */
export function AcceptInvite({ token }: { token: string }) {
  const invites = useMyInvites();
  const accept = useAcceptInvite();
  const me = useQuery({ queryKey: ["me"], queryFn: async () => (await getSupabase().auth.getUser()).data.user });
  const invite = invites.data?.find((i) => i.token === token);

  return (
    <Page>
      <div className="mx-auto mt-10 max-w-md rounded-lg border border-line bg-surface p-6">
        {invites.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : invite ? (
          <>
            <p className="text-[12px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Workspace invitation</p>
            <h1 className="mt-2 flex items-center gap-2 font-serif text-[24px] leading-tight">
              <WorkspaceIcon kind={invite.workspace_kind} className="size-5 text-ink-3" /> {invite.workspace_name}
            </h1>
            <p className="mt-2 text-sm text-ink-2">
              {invite.invited_by_email ?? "Someone"} invited you to this {WORKSPACE_KINDS[invite.workspace_kind].toLowerCase()} workspace as{" "}
              {WORKSPACE_ROLES[invite.role].toLowerCase()}.
            </p>
            <Button variant="primary" className="mt-5 w-full" disabled={accept.isPending} onClick={() => accept.mutate(token)}>
              {accept.isPending ? "Joining…" : `Join ${invite.workspace_name}`}
            </Button>
          </>
        ) : (
          <>
            <h1 className="font-serif text-[22px] leading-tight">This invite isn&apos;t available</h1>
            <p className="mt-2 text-sm text-ink-2">
              It may have expired, been revoked or already been used, or it was sent to a different email than the one you&apos;re signed in with
              {me.data?.email ? ` (${me.data.email})` : ""}. Ask the workspace owner for a new link.
            </p>
            <Link href="/dashboard">
              <Button className="mt-5">Go to your dashboard</Button>
            </Link>
          </>
        )}
      </div>
    </Page>
  );
}
