"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { Button } from "@/components/ui/button";
import { fetchMyWorkspaces, WORKSPACES } from "@/lib/queries/workspaces";
import { chooseWorkspace, getCurrentWorkspaceId, readWorkspaceCookie, setCurrentWorkspaceId, type Workspace } from "@/lib/workspace";

export interface WorkspaceContextValue {
  workspaces: Workspace[];
  current: Workspace;
  isBusiness: boolean;
  canEdit: boolean;
  isOwner: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** The open workspace. Only usable inside the app shell. */
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}

/**
 * Loads the user's workspaces, opens one (the remembered one, else the first) and only then
 * renders the app, so no query ever runs without a workspace.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const q = useQuery({
    queryKey: WORKSPACES,
    queryFn: async () => {
      const list = await fetchMyWorkspaces();
      const current = chooseWorkspace(list, getCurrentWorkspaceId() ?? readWorkspaceCookie());
      if (current) setCurrentWorkspaceId(current.id);
      return { list, currentId: current?.id ?? null };
    },
    staleTime: 5 * 60_000,
  });

  if (q.isError) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-paper text-sm text-ink-2">
        <p>Couldn&apos;t load your workspaces.</p>
        <p className="max-w-md text-center text-[12.5px] text-ink-3">
          {(q.error as { code?: string; message?: string })?.code === "PGRST202"
            ? "The database hasn't been updated for workspaces yet (its migrations aren't applied)."
            : ((q.error as { message?: string })?.message ?? "")}
        </p>
        <Button onClick={() => q.refetch()}>Try again</Button>
      </div>
    );
  }
  const current = q.data?.list.find((w) => w.id === q.data.currentId);
  if (!q.data || !current) return <div className="h-dvh bg-paper" />;

  const value: WorkspaceContextValue = {
    workspaces: q.data.list,
    current,
    isBusiness: current.kind === "business",
    canEdit: current.role !== "viewer",
    isOwner: current.role === "owner",
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
