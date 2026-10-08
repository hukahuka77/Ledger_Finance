"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";
import { unwrap } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";
import { setCurrentWorkspaceId, type Workspace, type WorkspaceKind, type WorkspaceRole } from "@/lib/workspace";

export const WORKSPACES = ["workspaces"] as const;

export interface WorkspaceMember {
  user_id: string;
  email: string;
  role: WorkspaceRole;
  joined_at: string;
}

export interface WorkspaceInvite {
  id: string;
  token: string;
  email: string;
  role: WorkspaceRole;
  created_at: string;
  expires_at: string;
}

export interface MyInvite {
  id: string;
  token: string;
  workspace_id: string;
  workspace_name: string;
  workspace_kind: WorkspaceKind;
  role: WorkspaceRole;
  invited_by_email: string | null;
  expires_at: string;
}

/** The signed-in user's workspaces. Creates a personal one for brand-new users. */
export async function fetchMyWorkspaces(): Promise<Workspace[]> {
  const sb = getSupabase();
  let list = await unwrap<Workspace[]>(sb.rpc("my_workspaces"));
  if (!list.length) {
    await unwrap(sb.rpc("ensure_personal_workspace", {}));
    list = await unwrap<Workspace[]>(sb.rpc("my_workspaces"));
  }
  return list;
}

export function useMyWorkspaces() {
  return useQuery({ queryKey: WORKSPACES, queryFn: fetchMyWorkspaces, staleTime: 5 * 60_000 });
}

/** Full page load, so every page, query cache and subscription starts clean in the new workspace. */
/** (A client-side navigation would keep the old workspace's cache.) */
function reloadTo(path: string) {
  window.location.assign(path);
}

/** Open a workspace: remember it and reload into it. */
export function openWorkspace(id: string, path = "/dashboard") {
  setCurrentWorkspaceId(id);
  reloadTo(path);
}

export function useCreateWorkspace() {
  return useMutation({
    mutationFn: ({ name, kind }: { name: string; kind: WorkspaceKind }) =>
      unwrap<string>(getSupabase().rpc("create_workspace", { p_name: name, p_kind: kind })),
    onSuccess: (id) => openWorkspace(id),
    onError: (e) => reportError(e, "Could not create the workspace."),
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => unwrap(getSupabase().from("workspaces").update({ name }).eq("id", id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WORKSPACES });
      toast.success("Workspace renamed");
    },
    onError: (e) => reportError(e, "Could not rename the workspace."),
  });
}

export function useDeleteWorkspace() {
  return useMutation({
    mutationFn: ({ id, confirmName }: { id: string; confirmName: string }) =>
      unwrap(getSupabase().rpc("delete_workspace", { p_workspace_id: id, p_confirm_name: confirmName })),
    onSuccess: () => {
      // Falls back to another workspace on reload.
      reloadTo("/dashboard");
    },
    onError: (e) => reportError(e, "Could not delete the workspace."),
  });
}

const membersKey = (id: string) => ["workspace-members", id] as const;
const invitesKey = (id: string) => ["workspace-invites", id] as const;

export function useWorkspaceMembers(id: string) {
  return useQuery({
    queryKey: membersKey(id),
    queryFn: () => unwrap<WorkspaceMember[]>(getSupabase().rpc("list_workspace_members", { p_workspace_id: id })),
  });
}

export function useWorkspaceInvites(id: string, enabled: boolean) {
  return useQuery({
    queryKey: invitesKey(id),
    enabled,
    queryFn: () =>
      unwrap<WorkspaceInvite[]>(
        getSupabase()
          .from("workspace_invites")
          .select("id, token, email, role, created_at, expires_at")
          .eq("workspace_id", id)
          .is("accepted_at", null)
          .order("created_at"),
      ),
  });
}

export function useInviteMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: WorkspaceRole }) =>
      unwrap<{ id: string; token: string }[]>(getSupabase().rpc("invite_to_workspace", { p_workspace_id: workspaceId, p_email: email, p_role: role })),
    onSuccess: () => qc.invalidateQueries({ queryKey: invitesKey(workspaceId) }),
    // The form shows the error inline.
  });
}

export function useRevokeInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => unwrap(getSupabase().rpc("revoke_workspace_invite", { p_invite_id: inviteId })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: invitesKey(workspaceId) });
      toast.success("Invite revoked");
    },
    onError: (e) => reportError(e, "Could not revoke the invite."),
  });
}

export function useSetMemberRole(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      unwrap(getSupabase().rpc("set_workspace_member_role", { p_workspace_id: workspaceId, p_user_id: userId, p_role: role })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
      toast.success("Role updated");
    },
    onError: (e) => reportError(e, "Could not change the role."),
  });
}

export function useRemoveMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => unwrap(getSupabase().rpc("remove_workspace_member", { p_workspace_id: workspaceId, p_user_id: userId })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
      toast.success("Member removed");
    },
    onError: (e) => reportError(e, "Could not remove the member."),
  });
}

/** Leave a workspace you were invited to. */
export function useLeaveWorkspace() {
  return useMutation({
    mutationFn: async ({ workspaceId }: { workspaceId: string }) => {
      const { data } = await getSupabase().auth.getUser();
      await unwrap(getSupabase().rpc("remove_workspace_member", { p_workspace_id: workspaceId, p_user_id: data.user!.id }));
    },
    onSuccess: () => reloadTo("/dashboard"),
    onError: (e) => reportError(e, "Could not leave the workspace."),
  });
}

export function useMyInvites() {
  return useQuery({ queryKey: ["my-invites"], queryFn: () => unwrap<MyInvite[]>(getSupabase().rpc("my_workspace_invites")), staleTime: 60_000 });
}

export function useAcceptInvite() {
  return useMutation({
    mutationFn: (token: string) => unwrap<string>(getSupabase().rpc("accept_workspace_invite", { p_token: token })),
    onSuccess: (id) => openWorkspace(id),
    onError: (e) => reportError(e, "Could not accept the invite."),
  });
}

export const inviteLink = (token: string) => `${window.location.origin}/invite/${token}`;
