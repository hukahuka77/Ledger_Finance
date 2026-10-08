"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Checkbox, Switch } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { CategoryPicker, CategoryPill } from "@/components/transactions/category-picker";
import type { Json } from "@/lib/database.types";
import {
  RULE_FIELDS,
  RULE_OPS,
  TRANSACTION_TYPE_OPTIONS,
  type CategorizationRule,
  type LedgerTransaction,
  type RuleActions,
  type RuleCondition,
  type RuleField,
} from "@/lib/domain";
import { useAccounts, useApplyRules, useCategoryIndex, useRecurringItems, useSaveRule, useTags, unwrap } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

type Cond = RuleCondition & { key: number };

export function RuleFormDialog({
  open,
  onOpenChange,
  rule,
  fromTransaction,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rule?: CategorizationRule;
  fromTransaction?: LedgerTransaction;
}) {
  if (!open) return null;
  return <RuleFormInner key={rule?.id ?? fromTransaction?.id ?? "new"} onOpenChange={onOpenChange} rule={rule} fromTransaction={fromTransaction} />;
}

function validCond(c: RuleCondition) {
  if (!c.value.trim()) return false;
  if (c.field === "amount") return /^\d+(\.\d{1,2})?$/.test(c.value.trim());
  return true;
}

function RuleFormInner({
  onOpenChange,
  rule,
  fromTransaction,
}: {
  onOpenChange: (o: boolean) => void;
  rule?: CategorizationRule;
  fromTransaction?: LedgerTransaction;
}) {
  const cats = useCategoryIndex();
  const { data: accounts } = useAccounts();
  const { data: tags } = useTags();
  const { data: recurring } = useRecurringItems();
  const save = useSaveRule();
  const apply = useApplyRules();

  const [name, setName] = useState(rule?.name ?? (fromTransaction ? `${fromTransaction.merchant_name}` : ""));
  const [conds, setConds] = useState<Cond[]>(() => {
    const src = (rule?.conditions as RuleCondition[] | undefined) ?? [
      { field: "merchant" as RuleField, op: "contains", value: fromTransaction?.merchant_name ?? "" },
    ];
    return src.map((c, i) => ({ ...c, key: i }));
  });
  const [actions, setActions] = useState<RuleActions>(
    () => (rule?.actions as RuleActions) ?? (fromTransaction?.category_id ? { category_id: fromTransaction.category_id } : {}),
  );
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [applyOnImport, setApplyOnImport] = useState(rule?.apply_on_import ?? true);
  const [active, setActive] = useState(rule?.active ?? true);
  const [applyNow, setApplyNow] = useState(!rule);
  const [nextKey, setNextKey] = useState(100);

  const cleanActions = Object.fromEntries(Object.entries(actions).filter(([, v]) => v)) as RuleActions;
  const condsValid = conds.length > 0 && conds.every(validCond);
  const valid = name.trim() && condsValid && Object.keys(cleanActions).length > 0 && /^-?\d+$/.test(priority);

  // Debounced live preview of how many transactions match.
  const payload = conds.map(({ field, op, value }) => ({ field, op, value: value.trim() }));
  const [debounced, setDebounced] = useState(payload);
  const payloadKey = JSON.stringify(payload);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.parse(payloadKey)), 350);
    return () => clearTimeout(t);
  }, [payloadKey]);
  const preview = useQuery({
    queryKey: ["rule-preview", debounced],
    enabled: debounced.length > 0 && debounced.every(validCond),
    queryFn: () => unwrap<number>(getSupabase().rpc("preview_rule_matches", { p_conditions: debounced as unknown as Json })),
  });

  const setCond = (key: number, patch: Partial<RuleCondition>) =>
    setConds((cs) =>
      cs.map((c) => {
        if (c.key !== key) return c;
        const next = { ...c, ...patch };
        if (patch.field && patch.field !== c.field) {
          next.op = RULE_OPS[patch.field][0].value;
          next.value = patch.field === "account" ? (accounts?.[0]?.id ?? "") : "";
        }
        return next;
      }),
    );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    save.mutate(
      {
        id: rule?.id,
        values: {
          name: name.trim(),
          conditions: payload as unknown as Json,
          actions: cleanActions as unknown as Json,
          priority: Number.parseInt(priority, 10),
          apply_on_import: applyOnImport,
          active,
        },
      },
      {
        onSuccess: (saved) => {
          if (applyNow) apply.mutate({ ruleId: saved.id, onlyUnreviewed: true });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={rule ? "Edit rule" : "New categorization rule"}
      description="When every condition matches, the actions are applied."
      className="max-w-2xl"
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Rule name" htmlFor="rule-name">
          <Input id="rule-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>

        <div>
          <p className="mb-2 text-[12px] font-medium tracking-wide text-ink-2">If</p>
          <div className="space-y-2">
            {conds.map((c, i) => (
              <div key={c.key} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <span className="w-8 text-[12px] text-ink-3">{i === 0 ? "" : "and"}</span>
                <Select className="w-40" aria-label="Field" value={c.field} onChange={(e) => setCond(c.key, { field: e.target.value as RuleField })}>
                  {Object.entries(RULE_FIELDS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Select className="w-36" aria-label="Operator" value={c.op} onChange={(e) => setCond(c.key, { op: e.target.value })}>
                  {RULE_OPS[c.field].map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {c.field === "account" ? (
                  <Select className="min-w-0 flex-1" aria-label="Account" value={c.value} onChange={(e) => setCond(c.key, { value: e.target.value })}>
                    {(accounts ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    className="min-w-0 flex-1"
                    aria-label="Value"
                    inputMode={c.field === "amount" ? "decimal" : undefined}
                    placeholder={c.field === "amount" ? "0.00" : "Text"}
                    value={c.value}
                    maxLength={200}
                    onChange={(e) => setCond(c.key, { value: e.target.value })}
                  />
                )}
                <IconButton
                  label="Remove condition"
                  size="sm"
                  variant="quiet"
                  disabled={conds.length <= 1}
                  onClick={() => setConds((cs) => cs.filter((x) => x.key !== c.key))}
                >
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between pl-10">
            <Button
              size="sm"
              variant="quiet"
              disabled={conds.length >= 10}
              onClick={() => {
                setConds((cs) => [...cs, { key: nextKey, field: "merchant", op: "contains", value: "" }]);
                setNextKey((k) => k + 1);
              }}
            >
              <Plus /> Add condition
            </Button>
            <span className="text-[12.5px] text-ink-3">
              {preview.isFetching
                ? "Counting…"
                : preview.data !== undefined && condsValid
                  ? `Matches ${preview.data.toLocaleString()} existing transaction${preview.data === 1 ? "" : "s"}`
                  : ""}
            </span>
          </div>
          <p className="mt-1 pl-10 text-[12px] text-ink-3">Text matching ignores case. Amount compares the absolute value.</p>
        </div>

        <div>
          <p className="mb-2 text-[12px] font-medium tracking-wide text-ink-2">Then</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Set category">
              <CategoryPicker value={actions.category_id ?? null} onChange={(id) => setActions((a) => ({ ...a, category_id: id ?? undefined }))}>
                <button type="button" className="flex h-8 w-full items-center rounded-md border border-line bg-surface px-2 hover:bg-hover">
                  {actions.category_id ? (
                    <CategoryPill category={cats.byId.get(actions.category_id)} />
                  ) : (
                    <span className="text-sm text-ink-3">Don&apos;t change</span>
                  )}
                </button>
              </CategoryPicker>
            </Field>
            <Field label="Set transaction type" htmlFor="rule-type">
              <Select
                id="rule-type"
                value={actions.transaction_type ?? ""}
                onChange={(e) => setActions((a) => ({ ...a, transaction_type: (e.target.value || undefined) as RuleActions["transaction_type"] }))}
              >
                <option value="">Don&apos;t change</option>
                {TRANSACTION_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Add tag" htmlFor="rule-tag">
              <Select id="rule-tag" value={actions.tag_id ?? ""} onChange={(e) => setActions((a) => ({ ...a, tag_id: e.target.value || undefined }))}>
                <option value="">None</option>
                {(tags ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mark recurring as" htmlFor="rule-rec">
              <Select
                id="rule-rec"
                value={actions.recurring_item_id ?? ""}
                onChange={(e) => setActions((a) => ({ ...a, recurring_item_id: e.target.value || undefined }))}
              >
                <option value="">Don&apos;t change</option>
                {(recurring ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rename merchant to" htmlFor="rule-merchant" className="sm:col-span-2">
              <Input
                id="rule-merchant"
                value={actions.merchant_name ?? ""}
                maxLength={200}
                placeholder="Leave blank to keep"
                onChange={(e) => setActions((a) => ({ ...a, merchant_name: e.target.value || undefined }))}
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-5 border-t border-line-soft pt-4">
          <Field label="Priority" htmlFor="rule-priority" className="w-24">
            <Input id="rule-priority" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-2">
            <Switch checked={active} onChange={setActive} label="Active" /> Active
          </label>
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-2">
            <Switch checked={applyOnImport} onChange={setApplyOnImport} label="Apply on import" /> Apply on import
          </label>
          <label className="mt-4 flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={applyNow} onChange={setApplyNow} label="Apply now" /> Apply now to unreviewed
          </label>
        </div>
        <p className="-mt-3 text-[12px] text-ink-3">Lower numbers win when several rules match the same transaction.</p>

        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || save.isPending}>
            {save.isPending ? "Saving…" : rule ? "Save rule" : "Create rule"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
