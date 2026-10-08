"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import type { TablesInsert, TablesUpdate } from "@/lib/database.types";
import type { Account, Category, CategorizationRule, RecurringItem, Tag } from "@/lib/domain";
import { reportError } from "@/lib/errors";
import { getSupabase } from "@/lib/supabase/client";
import { WORKSPACE_HEADER } from "@/lib/workspace";
import { recurringPatterns } from "@/lib/recurring-match";

export const qk = {
  accounts: ["accounts"] as const,
  categories: ["categories"] as const,
  tags: ["tags"] as const,
  recurring: ["recurring"] as const,
  rules: ["rules"] as const,
  transactions: ["transactions"] as const,
  analytics: ["analytics"] as const,
  counts: ["counts"] as const,
  calendar: ["calendar"] as const,
  imports: ["imports"] as const,
};

async function unwrap<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
export function useAccounts() {
  return useQuery({
    queryKey: qk.accounts,
    queryFn: () => unwrap<Account[]>(getSupabase().from("accounts").select("*").order("sort_order").order("name")),
    staleTime: 60_000,
  });
}

/** Accounts in every workspace the user belongs to: one bank login can feed several workspaces. */
export function useAllWorkspaceAccounts(enabled = true) {
  return useQuery({
    queryKey: [...qk.accounts, "all-workspaces"],
    queryFn: () => unwrap<Account[]>(getSupabase().from("accounts").select("*").order("name").setHeader(WORKSPACE_HEADER, "all")),
    enabled,
  });
}

export function useAccountIndex() {
  const { data } = useAccounts();
  return useMemo(() => new Map((data ?? []).map((a) => [a.id, a])), [data]);
}

export function useSaveAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string; values: TablesInsert<"accounts"> | TablesUpdate<"accounts"> }) => {
      const sb = getSupabase();
      if (id)
        return unwrap<Account>(
          sb
            .from("accounts")
            .update(values as TablesUpdate<"accounts">)
            .eq("id", id)
            .select()
            .single(),
        );
      return unwrap<Account>(
        sb
          .from("accounts")
          .insert(values as TablesInsert<"accounts">)
          .select()
          .single(),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.accounts });
      qc.invalidateQueries({ queryKey: qk.calendar });
    },
    onError: (e) => reportError(e, "Could not save account. Try again."),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(getSupabase().from("accounts").delete().eq("id", id)),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Account deleted");
    },
    onError: (e) => reportError(e, "Could not delete account."),
  });
}

/** Give another workspace its own copy of an account, history included (bank-synced copies keep syncing). */
export function useCopyAccountToWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ accountId, workspaceId }: { accountId: string; workspaceId: string; workspaceName: string }) =>
      unwrap<string>(getSupabase().rpc("copy_account_to_workspace", { p_account_id: accountId, p_target_ws: workspaceId })),
    onSuccess: (_id, v) => {
      qc.invalidateQueries({ queryKey: qk.accounts });
      toast.success(`Added to ${v.workspaceName}`);
    },
    onError: (e) => reportError(e, "Could not add the account to that workspace."),
  });
}

/** Move an account and its history to another workspace. Resolves to the account's new id. */
export function useMoveAccountToWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ accountId, workspaceId }: { accountId: string; workspaceId: string; workspaceName: string }) =>
      unwrap<string>(getSupabase().rpc("move_account_to_workspace", { p_account_id: accountId, p_target_ws: workspaceId })),
    onSuccess: (_id, v) => {
      qc.invalidateQueries();
      toast.success(`Moved to ${v.workspaceName}`);
    },
    onError: (e) => reportError(e, "Could not move the account."),
  });
}

/** Remove one workspace's copy of a mirrored bank account. */
export function useRemoveAccountCopy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ accountId }: { accountId: string; workspaceName: string }) =>
      unwrap(getSupabase().rpc("remove_account_copy", { p_account_id: accountId })),
    onSuccess: (_r, v) => {
      qc.invalidateQueries();
      toast.success(`Removed from ${v.workspaceName}`);
    },
    onError: (e) => reportError(e, "Could not remove the account from that workspace."),
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export function useCategories() {
  return useQuery({
    queryKey: qk.categories,
    queryFn: () => unwrap<Category[]>(getSupabase().from("categories").select("*").order("sort_order").order("name")),
    staleTime: 60_000,
  });
}

export interface CategoryIndex {
  all: Category[];
  byId: Map<string, Category>;
  /** Top-level categories in display order. */
  parents: Category[];
  childrenOf: (id: string) => Category[];
  /** "Restaurants" plus the parent for context. */
  parentOf: (id: string | null | undefined) => Category | undefined;
  /** A category id plus all its subcategory ids. */
  expand: (id: string) => string[];
}

export function buildCategoryIndex(all: Category[]): CategoryIndex {
  const byId = new Map(all.map((c) => [c.id, c]));
  const kids = new Map<string, Category[]>();
  const parents: Category[] = [];
  const order = (a: Category, b: Category) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);
  for (const c of all) {
    if (c.parent_category_id && byId.has(c.parent_category_id)) {
      const arr = kids.get(c.parent_category_id) ?? [];
      arr.push(c);
      kids.set(c.parent_category_id, arr);
    } else {
      parents.push(c);
    }
  }
  parents.sort(order);
  kids.forEach((arr) => arr.sort(order));
  return {
    all,
    byId,
    parents,
    childrenOf: (id) => kids.get(id) ?? [],
    parentOf: (id) => {
      const c = id ? byId.get(id) : undefined;
      return c?.parent_category_id ? byId.get(c.parent_category_id) : undefined;
    },
    expand: (id) => [id, ...(kids.get(id) ?? []).map((k) => k.id)],
  };
}

export function useCategoryIndex(): CategoryIndex & { isLoading: boolean } {
  const { data, isLoading } = useCategories();
  return useMemo(() => ({ ...buildCategoryIndex(data ?? []), isLoading }), [data, isLoading]);
}

export function useSaveCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string; values: TablesInsert<"categories"> | TablesUpdate<"categories"> }) => {
      const sb = getSupabase();
      if (id)
        return unwrap<Category>(
          sb
            .from("categories")
            .update(values as TablesUpdate<"categories">)
            .eq("id", id)
            .select()
            .single(),
        );
      return unwrap<Category>(
        sb
          .from("categories")
          .insert(values as TablesInsert<"categories">)
          .select()
          .single(),
      );
    },
    onMutate: async ({ id, values }) => {
      if (!id) return;
      await qc.cancelQueries({ queryKey: qk.categories });
      const prev = qc.getQueryData<Category[]>(qk.categories);
      qc.setQueryData<Category[]>(qk.categories, (old) => old?.map((c) => (c.id === id ? ({ ...c, ...values } as Category) : c)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.categories, ctx.prev);
      reportError(e, "Could not save category. Try again.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.categories });
      qc.invalidateQueries({ queryKey: qk.analytics });
    },
  });
}

export function useReorderCategories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ordered: { id: string; sort_order: number }[]) => {
      const sb = getSupabase();
      await Promise.all(ordered.map((o) => unwrap(sb.from("categories").update({ sort_order: o.sort_order }).eq("id", o.id))));
    },
    onMutate: async (ordered) => {
      await qc.cancelQueries({ queryKey: qk.categories });
      const prev = qc.getQueryData<Category[]>(qk.categories);
      const map = new Map(ordered.map((o) => [o.id, o.sort_order]));
      qc.setQueryData<Category[]>(qk.categories, (old) => old?.map((c) => (map.has(c.id) ? { ...c, sort_order: map.get(c.id)! } : c)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.categories, ctx.prev);
      reportError(e, "Could not reorder categories.");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.categories }),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(getSupabase().from("categories").delete().eq("id", id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.categories });
      qc.invalidateQueries({ queryKey: qk.transactions });
      qc.invalidateQueries({ queryKey: qk.analytics });
      toast.success("Category deleted");
    },
    onError: (e) => reportError(e, "Could not delete category."),
  });
}

export function useSeedCategories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => unwrap<number>(getSupabase().rpc("seed_default_categories")),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: qk.categories });
      toast.success(n ? `Added ${n} categories` : "Default categories already exist");
    },
    onError: (e) => reportError(e, "Could not add default categories."),
  });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
export function useTags() {
  return useQuery({
    queryKey: qk.tags,
    queryFn: () => unwrap<Tag[]>(getSupabase().from("tags").select("*").order("name")),
    staleTime: 60_000,
  });
}

export function useTagIndex() {
  const { data } = useTags();
  return useMemo(() => new Map((data ?? []).map((t) => [t.id, t])), [data]);
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const clean = name.trim().replace(/^#/, "").slice(0, 50);
      if (!clean) throw Object.assign(new Error("Tag name is required"), { code: "22023" });
      return unwrap<Tag>(getSupabase().from("tags").insert({ name: clean }).select().single());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tags }),
    onError: (e) => reportError(e, "Could not create tag."),
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: TablesUpdate<"tags"> }) =>
      unwrap<Tag>(getSupabase().from("tags").update(values).eq("id", id).select().single()),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tags }),
    onError: (e) => reportError(e, "Could not update tag."),
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(getSupabase().from("tags").delete().eq("id", id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.tags });
      qc.invalidateQueries({ queryKey: qk.transactions });
      toast.success("Tag deleted");
    },
    onError: (e) => reportError(e, "Could not delete tag."),
  });
}

// ---------------------------------------------------------------------------
// Recurring items
// ---------------------------------------------------------------------------
export function useRecurringItems() {
  return useQuery({
    queryKey: qk.recurring,
    queryFn: () => unwrap<RecurringItem[]>(getSupabase().from("recurring_items").select("*").order("next_expected_date").order("name")),
    staleTime: 60_000,
  });
}

export function useRecurringIndex() {
  const { data } = useRecurringItems();
  return useMemo(() => new Map((data ?? []).map((r) => [r.id, r])), [data]);
}

export function useSaveRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      values,
      linkMatching,
    }: {
      id?: string;
      values: TablesInsert<"recurring_items"> | TablesUpdate<"recurring_items">;
      linkMatching?: boolean;
    }) => {
      const sb = getSupabase();
      const item = id
        ? Object.keys(values).length === 0
          ? await unwrap<RecurringItem>(sb.from("recurring_items").select().eq("id", id).single())
          : await unwrap<RecurringItem>(
              sb
                .from("recurring_items")
                .update(values as TablesUpdate<"recurring_items">)
                .eq("id", id)
                .select()
                .single(),
            )
        : await unwrap<RecurringItem>(
            sb
              .from("recurring_items")
              .insert(values as TablesInsert<"recurring_items">)
              .select()
              .single(),
          );
      let linked = 0;
      if (linkMatching && recurringPatterns(item).length) {
        linked = await unwrap<number>(sb.rpc("link_recurring_transactions", { p_recurring_item_id: item.id }));
      }
      return { item, linked };
    },
    onSuccess: ({ linked }) => {
      qc.invalidateQueries({ queryKey: qk.recurring });
      qc.invalidateQueries({ queryKey: qk.calendar });
      if (linked) {
        qc.invalidateQueries({ queryKey: qk.transactions });
        toast.success(`Linked ${linked} matching transaction${linked === 1 ? "" : "s"}`);
      }
    },
    onError: (e) => reportError(e, "Could not save recurring item."),
  });
}

export function useDeleteRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(getSupabase().from("recurring_items").delete().eq("id", id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.recurring });
      qc.invalidateQueries({ queryKey: qk.calendar });
      qc.invalidateQueries({ queryKey: qk.transactions });
      toast.success("Recurring item deleted");
    },
    onError: (e) => reportError(e, "Could not delete recurring item."),
  });
}

// ---------------------------------------------------------------------------
// Categorization rules
// ---------------------------------------------------------------------------
export function useRules() {
  return useQuery({
    queryKey: qk.rules,
    queryFn: () => unwrap<CategorizationRule[]>(getSupabase().from("categorization_rules").select("*").order("priority").order("created_at")),
  });
}

export function useSaveRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string; values: TablesInsert<"categorization_rules"> | TablesUpdate<"categorization_rules"> }) => {
      const sb = getSupabase();
      if (id)
        return unwrap<CategorizationRule>(
          sb
            .from("categorization_rules")
            .update(values as TablesUpdate<"categorization_rules">)
            .eq("id", id)
            .select()
            .single(),
        );
      return unwrap<CategorizationRule>(
        sb
          .from("categorization_rules")
          .insert(values as TablesInsert<"categorization_rules">)
          .select()
          .single(),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.rules }),
    onError: (e) => reportError(e, "Could not save rule."),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(getSupabase().from("categorization_rules").delete().eq("id", id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.rules });
      toast.success("Rule deleted");
    },
    onError: (e) => reportError(e, "Could not delete rule."),
  });
}

export function useApplyRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { ruleId?: string; onlyUnreviewed: boolean }) =>
      unwrap<number>(getSupabase().rpc("apply_categorization_rules", { p_rule_id: args.ruleId, p_only_unreviewed: args.onlyUnreviewed })),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: qk.rules });
      qc.invalidateQueries({ queryKey: qk.transactions });
      qc.invalidateQueries({ queryKey: qk.analytics });
      toast.success(n ? `Updated ${n} transaction${n === 1 ? "" : "s"}` : "No matching transactions");
    },
    onError: (e) => reportError(e, "Could not apply rules."),
  });
}

export { unwrap };
