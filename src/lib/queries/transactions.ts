"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Json, TablesInsert, TablesUpdate } from "@/lib/database.types";
import type { LedgerTransaction, Transaction } from "@/lib/domain";
import { reportError } from "@/lib/errors";
import type { TransactionFilters } from "@/lib/filters";
import { UNCATEGORIZED } from "@/lib/filters";
import { qk, unwrap, type CategoryIndex } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

export const PAGE_SIZE = 100;
const SELECT = "*, transaction_tags(tag_id), transaction_splits(id, category_id, amount, notes, sort_order)";

type Page = { rows: LedgerTransaction[]; count: number | null; offset: number };
type ListData = InfiniteData<Page, number>;

/** Base query: plain table, or the search RPC when there is a search term. */
function baseQuery(f: TransactionFilters, withTagJoin: boolean, count: boolean) {
  const sb = getSupabase();
  const select = withTagJoin ? `${SELECT}, tag_filter:transaction_tags!inner(tag_id)` : SELECT;
  const opts = count ? { count: "exact" as const } : undefined;
  return f.q.trim() ? sb.rpc("search_transactions", { q: f.q.trim() }, opts).select(select) : sb.from("transactions").select(select, opts);
}

export function buildListQuery(f: TransactionFilters, cats: CategoryIndex, offset: number, count: boolean) {
  let q = baseQuery(f, f.tags.length > 0, count);

  if (f.review !== "all") q = q.eq("review_status", f.review);
  if (f.accounts.length) q = q.in("account_id", f.accounts);
  if (f.types.length) q = q.in("transaction_type", f.types);
  if (f.status) q = q.eq("status", f.status);
  if (f.recurring === "yes") q = q.not("recurring_item_id", "is", null);
  if (f.recurring === "no") q = q.is("recurring_item_id", null);
  if (f.excluded === "yes") q = q.eq("excluded", true);
  if (f.excluded === "no") q = q.eq("excluded", false);
  if (f.from) q = q.gte("transaction_date", f.from);
  if (f.to) q = q.lte("transaction_date", f.to);
  if (f.min) q = q.gte("amount_abs", Number(f.min));
  if (f.max) q = q.lte("amount_abs", Number(f.max));
  if (f.tags.length) q = q.in("tag_filter.tag_id", f.tags);
  if (f.categories.length) {
    const wantNone = f.categories.includes(UNCATEGORIZED);
    const ids = [...new Set(f.categories.filter((c) => c !== UNCATEGORIZED).flatMap((c) => cats.expand(c)))];
    if (wantNone && ids.length) q = q.or(`category_id.is.null,category_id.in.(${ids.join(",")})`);
    else if (wantNone) q = q.is("category_id", null);
    else q = q.in("category_id", ids);
  }

  switch (f.sort) {
    case "oldest":
      q = q.order("transaction_date", { ascending: true }).order("id", { ascending: true });
      break;
    case "amount_desc":
      q = q.order("amount_abs", { ascending: false }).order("transaction_date", { ascending: false }).order("id");
      break;
    case "amount_asc":
      q = q.order("amount_abs", { ascending: true }).order("transaction_date", { ascending: false }).order("id");
      break;
    case "merchant_asc":
      q = q.order("merchant_name", { ascending: true }).order("transaction_date", { ascending: false }).order("id");
      break;
    case "merchant_desc":
      q = q.order("merchant_name", { ascending: false }).order("transaction_date", { ascending: false }).order("id");
      break;
    default:
      q = q.order("transaction_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false });
  }
  return q.range(offset, offset + PAGE_SIZE - 1);
}

export function useTransactionList(filters: TransactionFilters, cats: CategoryIndex, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...qk.transactions, "list", filters],
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<Page> => {
      const { data, error, count } = await buildListQuery(filters, cats, pageParam, pageParam === 0);
      if (error) throw error;
      const rows = ((data ?? []) as unknown as (LedgerTransaction & { tag_filter?: unknown })[]).map((r) => {
        delete r.tag_filter;
        return r as LedgerTransaction;
      });
      return { rows, count: count ?? null, offset: pageParam };
    },
    getNextPageParam: (last) => (last.rows.length < PAGE_SIZE ? undefined : last.offset + PAGE_SIZE),
    placeholderData: (prev) => prev,
  });
}

export function useTransaction(id: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...qk.transactions, "one", id],
    enabled: Boolean(id),
    queryFn: async () => unwrap<LedgerTransaction>(getSupabase().from("transactions").select(SELECT).eq("id", id!).single()),
    initialData: () => (id ? findInLists(qc, id) : undefined),
    initialDataUpdatedAt: 0,
  });
}

export function findInLists(qc: QueryClient, id: string): LedgerTransaction | undefined {
  for (const [, data] of qc.getQueriesData<ListData>({ queryKey: [...qk.transactions, "list"] })) {
    for (const p of data?.pages ?? []) {
      const hit = p.rows.find((r) => r.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Apply a local change to every cached copy of the given transactions. */
function patchCaches(qc: QueryClient, ids: Set<string>, fn: (t: LedgerTransaction) => LedgerTransaction) {
  qc.setQueriesData<ListData>({ queryKey: [...qk.transactions, "list"] }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, rows: p.rows.map((r) => (ids.has(r.id) ? fn(r) : r)) })) } : data,
  );
  ids.forEach((id) => qc.setQueryData<LedgerTransaction>([...qk.transactions, "one", id], (t) => (t ? fn(t) : t)));
}

function removeFromCaches(qc: QueryClient, ids: Set<string>) {
  qc.setQueriesData<ListData>({ queryKey: [...qk.transactions, "list"] }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            rows: p.rows.filter((r) => !ids.has(r.id)),
            count: p.count === null ? null : Math.max(0, p.count - ids.size),
          })),
        }
      : data,
  );
}

function snapshot(qc: QueryClient) {
  return qc.getQueriesData({ queryKey: qk.transactions });
}
function restore(qc: QueryClient, snap: ReturnType<typeof snapshot>) {
  snap.forEach(([key, data]) => qc.setQueryData(key, data));
}

function invalidateDerived(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: qk.analytics });
  qc.invalidateQueries({ queryKey: qk.counts });
  qc.invalidateQueries({ queryKey: qk.calendar });
}

export const TXN_MUTATION_KEY = ["txn-save"];

/** Optimistic single-transaction update (autosave). */
export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: TXN_MUTATION_KEY,
    mutationFn: async ({ id, patch }: { id: string; patch: TablesUpdate<"transactions"> }) =>
      unwrap<Transaction>(getSupabase().from("transactions").update(patch).eq("id", id).select().single()),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: [...qk.transactions, "one", id] });
      const snap = snapshot(qc);
      patchCaches(qc, new Set([id]), (t) => ({ ...t, ...patch }) as LedgerTransaction);
      return { snap };
    },
    onError: (e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      reportError(e, "Could not update transaction. Try again.");
    },
    onSuccess: (row) => {
      // Server-computed fields (reviewed_at, amount_abs, updated_at…)
      patchCaches(qc, new Set([row.id]), (t) => ({ ...t, ...row }));
      invalidateDerived(qc);
    },
  });
}

export function useSetTransactionTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: TXN_MUTATION_KEY,
    mutationFn: async ({ id, add, remove }: { id: string; add: string[]; remove: string[]; next: string[] }) => {
      const sb = getSupabase();
      if (add.length) await unwrap(sb.from("transaction_tags").insert(add.map((tag_id) => ({ transaction_id: id, tag_id }))));
      if (remove.length) await unwrap(sb.from("transaction_tags").delete().eq("transaction_id", id).in("tag_id", remove));
    },
    onMutate: ({ id, next }) => {
      const snap = snapshot(qc);
      patchCaches(qc, new Set([id]), (t) => ({ ...t, transaction_tags: next.map((tag_id) => ({ tag_id })) }));
      return { snap };
    },
    onError: (e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      reportError(e, "Could not update tags.");
    },
  });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (values: TablesInsert<"transactions">) =>
      unwrap<LedgerTransaction>(getSupabase().from("transactions").insert(values).select(SELECT).single()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.transactions });
      invalidateDerived(qc);
      toast.success("Transaction added");
    },
    onError: (e) => reportError(e, "Could not add transaction."),
  });
}

export function useDuplicateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (t: LedgerTransaction) => {
      const copy: TablesInsert<"transactions"> = {
        account_id: t.account_id,
        transaction_date: t.transaction_date,
        merchant_name: t.merchant_name,
        original_description: t.original_description,
        amount: t.amount,
        currency: t.currency,
        transaction_type: t.transaction_type,
        category_id: t.category_id,
        status: t.status,
        excluded: t.excluded,
        notes: t.notes,
        recurring_item_id: t.recurring_item_id,
      };
      const row = await unwrap<LedgerTransaction>(getSupabase().from("transactions").insert(copy).select(SELECT).single());
      if (t.transaction_tags.length) {
        await unwrap(
          getSupabase()
            .from("transaction_tags")
            .insert(t.transaction_tags.map((x) => ({ transaction_id: row.id, tag_id: x.tag_id }))),
        );
      }
      return row;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.transactions });
      invalidateDerived(qc);
      toast.success("Transaction duplicated");
    },
    onError: (e) => reportError(e, "Could not duplicate transaction."),
  });
}

export function useBulkUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: TXN_MUTATION_KEY,
    mutationFn: async ({ ids, patch }: { ids: string[]; patch: Record<string, Json>; silent?: boolean }) =>
      unwrap<number>(getSupabase().rpc("bulk_update_transactions", { p_ids: ids, p_patch: patch })),
    onMutate: ({ ids, patch }) => {
      const snap = snapshot(qc);
      patchCaches(qc, new Set(ids), (t) => ({ ...t, ...(patch as Partial<LedgerTransaction>) }));
      return { snap };
    },
    onError: (e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      reportError(e, "Could not update transactions.");
    },
    onSuccess: (n, { silent }) => {
      invalidateDerived(qc);
      if (!silent) toast.success(`Updated ${n} transaction${n === 1 ? "" : "s"}`);
    },
  });
}

export function useBulkAddTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, tagId }: { ids: string[]; tagId: string }) => unwrap<number>(getSupabase().rpc("bulk_add_tag", { p_ids: ids, p_tag_id: tagId })),
    onMutate: ({ ids, tagId }) => {
      patchCaches(qc, new Set(ids), (t) =>
        t.transaction_tags.some((x) => x.tag_id === tagId) ? t : { ...t, transaction_tags: [...t.transaction_tags, { tag_id: tagId }] },
      );
    },
    onSuccess: (n) => toast.success(`Tagged ${n} transaction${n === 1 ? "" : "s"}`),
    onError: (e) => {
      qc.invalidateQueries({ queryKey: qk.transactions });
      reportError(e, "Could not add tag.");
    },
  });
}

export function useDeleteTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => unwrap<number>(getSupabase().rpc("bulk_delete_transactions", { p_ids: ids })),
    onMutate: (ids) => {
      const snap = snapshot(qc);
      removeFromCaches(qc, new Set(ids));
      return { snap };
    },
    onError: (e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      reportError(e, "Could not delete transactions.");
    },
    onSuccess: (n) => {
      invalidateDerived(qc);
      toast.success(`Deleted ${n} transaction${n === 1 ? "" : "s"}`);
    },
  });
}

export function useSetSplits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, splits }: { id: string; splits: { category_id: string | null; amount: number; notes?: string | null }[] }) => {
      await unwrap(getSupabase().rpc("set_transaction_splits", { p_transaction_id: id, p_splits: splits as unknown as Json }));
      return unwrap<LedgerTransaction>(getSupabase().from("transactions").select(SELECT).eq("id", id).single());
    },
    onSuccess: (row, { splits }) => {
      patchCaches(qc, new Set([row.id]), () => row);
      invalidateDerived(qc);
      toast.success(splits.length ? "Split saved" : "Split removed");
    },
    onError: (e) => reportError(e, "Could not save split."),
  });
}

export function useLinkTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, type }: { ids: string[]; type: "transfer" | "credit_card_payment" }) =>
      unwrap<string>(getSupabase().rpc("link_transfer", { p_ids: ids, p_type: type })),
    onSuccess: (group, { ids, type }) => {
      patchCaches(qc, new Set(ids), (t) => ({ ...t, transfer_group_id: group, transaction_type: type }));
      qc.invalidateQueries({ queryKey: qk.transactions });
      invalidateDerived(qc);
      toast.success(ids.length > 1 ? "Transfer linked" : "Marked as transfer");
    },
    onError: (e) => reportError(e, "Could not link transfer."),
  });
}

export function useUnlinkTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (groupId: string) => unwrap(getSupabase().rpc("unlink_transfer", { p_group_id: groupId })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.transactions });
      toast.success("Transfer unlinked");
    },
    onError: (e) => reportError(e, "Could not unlink transfer."),
  });
}

/** The other leg(s) of a linked transfer. */
export function useTransferLegs(groupId: string | null, selfId: string) {
  return useQuery({
    queryKey: [...qk.transactions, "transfer", groupId],
    enabled: Boolean(groupId),
    queryFn: async () => unwrap<Transaction[]>(getSupabase().from("transactions").select("*").eq("transfer_group_id", groupId!).neq("id", selfId)),
  });
}

/** Likely counterpart: opposite amount, different account, within ±5 days. */
export function useTransferCandidates(t: Transaction | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...qk.transactions, "transfer-candidates", t?.id],
    enabled: Boolean(t) && enabled,
    queryFn: async () => {
      const d = new Date(`${t!.transaction_date}T00:00:00`);
      const from = new Date(d);
      from.setDate(d.getDate() - 5);
      const to = new Date(d);
      to.setDate(d.getDate() + 5);
      const iso = (x: Date) => x.toISOString().slice(0, 10);
      return unwrap<Transaction[]>(
        getSupabase()
          .from("transactions")
          .select("*")
          .eq("amount", -t!.amount)
          .neq("account_id", t!.account_id)
          .gte("transaction_date", iso(from))
          .lte("transaction_date", iso(to))
          .is("transfer_group_id", null)
          .limit(10),
      );
    },
  });
}

export function useUnreviewedCount() {
  return useQuery({
    queryKey: [...qk.counts, "unreviewed"],
    queryFn: async () => {
      const { count, error } = await getSupabase().from("transactions").select("id", { count: "exact", head: true }).eq("review_status", "unreviewed");
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 30_000,
  });
}

/** Simple recent/filtered list without paging (dashboard, account and recurring detail pages). */
export function useTransactionsSimple(key: unknown[], fetcher: () => PromiseLike<{ data: unknown; error: unknown }>, enabled = true) {
  return useQuery({
    queryKey: [...qk.transactions, "simple", ...key],
    enabled,
    queryFn: async () => unwrap<LedgerTransaction[]>(fetcher() as PromiseLike<{ data: LedgerTransaction[] | null; error: unknown }>),
  });
}

export { SELECT as TRANSACTION_SELECT };
