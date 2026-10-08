"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/dialog";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { cn } from "@/lib/cn";
import type { Account } from "@/lib/domain";
import { useCopyAccountToWorkspace, useRemoveAccountCopy } from "@/lib/queries/reference";
import type { Workspace } from "@/lib/workspace";

/**
 * One checkbox per workspace for a linked bank account. Ticking a workspace gives it its own copy
 * (full history, kept in sync); unticking deletes that workspace's copy. The last copy can't be
 * unticked: tick the new workspace first, then untick the old one to move it.
 */
export function WorkspaceChecks({ copies, onRemoved }: { copies: Account[]; onRemoved?: (accountId: string) => void }) {
  const { workspaces, current } = useWorkspace();
  const copy = useCopyAccountToWorkspace();
  const remove = useRemoveAccountCopy();
  const confirm = useConfirm();
  const busy = copy.isPending || remove.isPending;
  const source = copies.find((a) => a.workspace_id === current.id) ?? copies[0];
  const canEdit = (wsId: string) => workspaces.find((w) => w.id === wsId)?.role !== "viewer";

  const toggle = async (ws: Workspace, on: boolean) => {
    if (on) {
      copy.mutate({ accountId: source.id, workspaceId: ws.id, workspaceName: ws.name });
      return;
    }
    const target = copies.find((a) => a.workspace_id === ws.id);
    if (!target) return;
    const others = copies
      .filter((a) => a.id !== target.id)
      .map((a) => workspaces.find((w) => w.id === a.workspace_id)?.name)
      .filter(Boolean)
      .join(" and ");
    const ok = await confirm({
      title: `Remove ${target.name} from ${ws.name}?`,
      body: `${ws.name}'s copy of this account and its transactions are deleted, along with any categories, notes and tags set there. ${others} keeps its copy and stays synced.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) remove.mutate({ accountId: target.id, workspaceName: ws.name }, { onSuccess: () => onRemoved?.(target.id) });
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
      <span>Show in</span>
      {workspaces.map((ws) => {
        const has = copies.some((a) => a.workspace_id === ws.id);
        const onlyCopy = has && copies.length === 1;
        const reason = !canEdit(ws.id)
          ? `You can only view ${ws.name}`
          : onlyCopy
            ? "An account needs at least one workspace. To move it, tick the other workspace first, then untick this one."
            : !has && !canEdit(source.workspace_id)
              ? "You can only view the workspace this account is in"
              : undefined;
        const disabled = busy || Boolean(reason);
        return (
          <label key={ws.id} className={cn("flex min-w-0 items-center gap-1.5", disabled ? "cursor-not-allowed" : "cursor-pointer text-ink-2")} title={reason}>
            <Checkbox checked={has} disabled={disabled} title={reason} label={`Show in ${ws.name}`} onChange={(v) => toggle(ws, v)} />
            <span className="max-w-[220px] truncate">{ws.name}</span>
          </label>
        );
      })}
    </div>
  );
}
