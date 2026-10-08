/**
 * The workspace the app is working in. Every database request carries it as the
 * `x-workspace-id` header, which row-level security uses to scope reads and as the
 * default workspace for new rows. It's also kept in a cookie so API routes know it.
 */
export const WORKSPACE_HEADER = "x-workspace-id";
export const WORKSPACE_COOKIE = "ledger_ws";

export type WorkspaceKind = "personal" | "business";
export type WorkspaceRole = "owner" | "editor" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
  created_at: string;
}

export const WORKSPACE_KINDS: Record<WorkspaceKind, string> = { personal: "Personal", business: "Business" };
export const WORKSPACE_ROLES: Record<WorkspaceRole, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };
export const ROLE_HINTS: Record<WorkspaceRole, string> = {
  owner: "Full access, plus members, invites and deleting the workspace",
  editor: "Can add, edit and delete everything in the workspace",
  viewer: "Can see everything, can't change anything",
};

let currentId: string | null = null;

export function getCurrentWorkspaceId(): string | null {
  return currentId;
}

export function setCurrentWorkspaceId(id: string) {
  currentId = id;
  try {
    document.cookie = `${WORKSPACE_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  } catch {
    /* not in a browser */
  }
}

export function readWorkspaceCookie(): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${WORKSPACE_COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/** Pick the workspace to open: the remembered one if still a member, else the first. */
export function chooseWorkspace(list: Workspace[], remembered: string | null): Workspace | undefined {
  return list.find((w) => w.id === remembered) ?? list[0];
}
