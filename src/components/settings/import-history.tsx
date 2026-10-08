"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { ImportRecord } from "@/lib/domain";
import { reportError } from "@/lib/errors";
import { qk, unwrap } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

export function ImportHistory() {
  const { data, isLoading } = useQuery({
    queryKey: qk.imports,
    queryFn: () => unwrap<ImportRecord[]>(getSupabase().from("imports").select("*").order("created_at", { ascending: false }).limit(50)),
  });
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.length) return <EmptyState title="No imports yet." body="Every CSV you import is recorded here with row-level detail." className="py-10" />;

  return (
    <div className="divide-y divide-line-soft rounded-md border border-line bg-surface">
      {data.map((imp) => (
        <div key={imp.id}>
          <button
            type="button"
            onClick={() => setOpen(open === imp.id ? null : imp.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover/50"
            aria-expanded={open === imp.id}
          >
            <ChevronRight className={cn("size-4 shrink-0 text-ink-3 transition-transform", open === imp.id && "rotate-90")} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{imp.filename}</p>
              <p className="text-[12px] text-ink-3">
                {new Date(imp.created_at).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}
                {imp.status !== "completed" ? (
                  <span className={cn("ml-2", imp.status === "failed" ? "text-brick" : "text-ochre")}>
                    {imp.status === "failed" ? "Failed" : "In progress"}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="tabular hidden gap-5 text-right text-[12.5px] text-ink-2 sm:flex">
              <span>{imp.row_count.toLocaleString()} rows</span>
              <span className="text-ink">{imp.imported_count.toLocaleString()} imported</span>
              <span>{imp.duplicate_count.toLocaleString()} duplicates</span>
              {imp.error_count ? <span className="text-brick">{imp.error_count.toLocaleString()} errors</span> : null}
            </div>
          </button>
          {open === imp.id ? <ImportDetail imp={imp} /> : null}
        </div>
      ))}
    </div>
  );
}

function ImportDetail({ imp }: { imp: ImportRecord }) {
  const [status, setStatus] = useState<"all" | "imported" | "duplicate" | "error" | "skipped">("all");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const rows = useQuery({
    queryKey: [...qk.imports, imp.id, status],
    queryFn: () => {
      let q = getSupabase().from("import_rows").select("id, row_number, status, message, raw").eq("import_id", imp.id).order("row_number").limit(200);
      if (status !== "all") q = q.eq("status", status);
      return unwrap<{ id: string; row_number: number; status: string; message: string | null; raw: Record<string, string> }[]>(q);
    },
  });

  const undo = useMutation({
    mutationFn: async () => {
      const sb = getSupabase();
      await unwrap(sb.from("transactions").delete().eq("import_id", imp.id));
      await unwrap(sb.from("imports").delete().eq("id", imp.id));
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Import undone");
    },
    onError: (e) => reportError(e, "Could not undo import."),
  });

  return (
    <div className="border-t border-line-soft bg-paper px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          size="sm"
          ariaLabel="Row status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All" },
            { value: "imported", label: "Imported" },
            { value: "duplicate", label: "Duplicates" },
            { value: "error", label: "Errors" },
            { value: "skipped", label: "Skipped" },
          ]}
        />
        <Button
          size="sm"
          variant="danger"
          disabled={undo.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: "Undo this import?",
              body: `This deletes the ${imp.imported_count.toLocaleString()} transactions it created (including any edits you made to them). Accounts, categories and recurring items it created are kept.`,
              confirmLabel: "Undo import",
              danger: true,
            });
            if (ok) undo.mutate();
          }}
        >
          <Undo2 /> {undo.isPending ? "Undoing…" : "Undo import"}
        </Button>
      </div>
      {rows.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : !rows.data?.length ? (
        <p className="py-4 text-center text-sm text-ink-3">No rows.</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-md border border-line bg-surface">
          <table className="w-full text-[12.5px]">
            <tbody>
              {rows.data.map((r) => (
                <tr key={r.id} className="border-b border-line-soft last:border-0">
                  <td className="tabular w-16 px-3 py-1.5 text-ink-3">#{r.row_number}</td>
                  <td className="w-24 px-2 py-1.5 capitalize">
                    <span
                      className={cn(
                        r.status === "error" ? "text-brick" : r.status === "duplicate" ? "text-ochre" : r.status === "imported" ? "text-sage" : "text-ink-3",
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="max-w-0 truncate px-2 py-1.5 text-ink-2">
                    {Object.values(r.raw ?? {})
                      .slice(0, 5)
                      .join(" · ")}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap text-ink-3">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.data.length === 200 ? <p className="px-3 py-2 text-[12px] text-ink-3">Showing the first 200 rows.</p> : null}
        </div>
      )}
    </div>
  );
}
