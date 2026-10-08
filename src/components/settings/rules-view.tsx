"use client";

import { MoreHorizontal, Play, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { RuleFormDialog } from "@/components/forms/rule-form";
import { Page, PageHeader } from "@/components/layout/app-shell";
import { CategoryPill } from "@/components/transactions/category-picker";
import { Button, IconButton } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { RULE_FIELDS, RULE_OPS, TRANSACTION_TYPES, type CategorizationRule, type RuleActions, type RuleCondition } from "@/lib/domain";
import {
  useAccountIndex,
  useApplyRules,
  useCategoryIndex,
  useDeleteRule,
  useRecurringIndex,
  useRules,
  useSaveRule,
  useTagIndex,
} from "@/lib/queries/reference";

export function RulesView() {
  const { data: rules, isLoading } = useRules();
  const apply = useApplyRules();
  const [editing, setEditing] = useState<CategorizationRule | undefined>();
  const [open, setOpen] = useState(false);

  return (
    <Page>
      <p className="mb-2 text-[13px] text-ink-3">
        <Link href="/settings" className="hover:text-ink-2">
          Settings
        </Link>{" "}
        / Rules
      </p>
      <PageHeader
        title="Categorization rules"
        subtitle="Rules run on new imports and whenever you apply them. Higher rules win when several match."
        actions={
          <>
            <Button disabled={!rules?.length || apply.isPending} onClick={() => apply.mutate({ onlyUnreviewed: true })}>
              <Play /> {apply.isPending ? "Applying…" : "Apply all to unreviewed"}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setEditing(undefined);
                setOpen(true);
              }}
            >
              <Plus /> New rule
            </Button>
          </>
        }
      />
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !rules?.length ? (
        <EmptyState
          title="No rules yet."
          body="For example: if merchant contains “DOORDASH”, set category to Restaurants. You can also create a rule from any transaction's ••• menu."
          action={<Button onClick={() => setOpen(true)}>Create a rule</Button>}
        />
      ) : (
        <ul className="divide-y divide-line-soft border-y border-line">
          {rules.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onEdit={() => {
                setEditing(r);
                setOpen(true);
              }}
            />
          ))}
        </ul>
      )}
      <RuleFormDialog open={open} onOpenChange={setOpen} rule={editing} />
    </Page>
  );
}

function RuleRow({ rule: r, onEdit }: { rule: CategorizationRule; onEdit: () => void }) {
  const save = useSaveRule();
  const del = useDeleteRule();
  const apply = useApplyRules();
  const confirm = useConfirm();
  const accounts = useAccountIndex();
  const cats = useCategoryIndex();
  const tags = useTagIndex();
  const recurring = useRecurringIndex();
  const conds = r.conditions as RuleCondition[];
  const actions = r.actions as RuleActions;

  const condText = conds
    .map((c) => {
      const op = RULE_OPS[c.field]?.find((o) => o.value === c.op)?.label ?? c.op;
      const value = c.field === "account" ? (accounts.get(c.value)?.name ?? "account") : c.field === "amount" ? `$${c.value}` : `“${c.value}”`;
      return `${RULE_FIELDS[c.field] ?? c.field} ${op} ${value}`;
    })
    .join(" and ");

  return (
    <li className={cn("flex items-start gap-3 py-3", !r.active && "opacity-55")}>
      <span className="tabular mt-0.5 w-8 shrink-0 text-[12px] text-ink-3">#{r.priority}</span>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <p className="text-[14.5px] text-ink hover:underline">{r.name}</p>
        <p className="mt-0.5 text-[12.5px] text-ink-2">If {condText}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-2">
          <span className="text-ink-3">then</span>
          {actions.category_id ? <CategoryPill category={cats.byId.get(actions.category_id)} /> : null}
          {actions.transaction_type ? <span className="rounded-full border border-line px-2 py-0.5">{TRANSACTION_TYPES[actions.transaction_type]}</span> : null}
          {actions.tag_id ? <span className="rounded-full border border-line px-2 py-0.5">#{tags.get(actions.tag_id)?.name ?? "tag"}</span> : null}
          {actions.recurring_item_id ? (
            <span className="rounded-full border border-line px-2 py-0.5">Recurring: {recurring.get(actions.recurring_item_id)?.name ?? "item"}</span>
          ) : null}
          {actions.merchant_name ? <span className="rounded-full border border-line px-2 py-0.5">Rename → {actions.merchant_name}</span> : null}
        </div>
      </button>
      <span className="tabular hidden w-28 text-right text-[12px] text-ink-3 sm:block">Applied {r.times_applied.toLocaleString()}×</span>
      <Switch checked={r.active} onChange={(v) => save.mutate({ id: r.id, values: { active: v } })} label={`${r.name} active`} />
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={`More for ${r.name}`} size="sm" variant="quiet">
            <MoreHorizontal />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={onEdit}>Edit</MenuItem>
          <MenuItem onSelect={() => apply.mutate({ ruleId: r.id, onlyUnreviewed: true })}>Apply to unreviewed</MenuItem>
          <MenuItem
            onSelect={async () => {
              if (
                await confirm({
                  title: "Apply to all transactions?",
                  body: "This also changes transactions you've already reviewed.",
                  confirmLabel: "Apply to all",
                })
              )
                apply.mutate({ ruleId: r.id, onlyUnreviewed: false });
            }}
          >
            Apply to all transactions
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            onSelect={async () => {
              if (
                await confirm({
                  title: `Delete rule “${r.name}”?`,
                  body: "Transactions it already changed stay as they are.",
                  confirmLabel: "Delete",
                  danger: true,
                })
              )
                del.mutate(r.id);
            }}
          >
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}
