"use client";

import { Command } from "cmdk";
import { Check, Plus, Tag as TagIcon, X } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import type { Tag } from "@/lib/domain";
import { useCreateTag, useTags } from "@/lib/queries/reference";

export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface pr-1.5 pl-2 text-[12.5px] text-ink">
      <span className="text-ink-3">#</span>
      {tag.name}
      {onRemove ? (
        <button type="button" aria-label={`Remove tag ${tag.name}`} onClick={onRemove} className="ml-0.5 rounded-sm text-ink-3 hover:text-ink">
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/** Multi-select tag picker that can also create tags inline. */
export function TagPicker({
  selected,
  onToggle,
  children,
  closeOnPick,
}: {
  selected: string[];
  onToggle: (tagId: string, on: boolean) => void;
  children: React.ReactNode;
  closeOnPick?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: tags } = useTags();
  const create = useCreateTag();
  const clean = query.trim().replace(/^#/, "");
  const exists = (tags ?? []).some((t) => t.name.toLowerCase() === clean.toLowerCase());

  const toggle = (id: string, on: boolean) => {
    onToggle(id, on);
    if (closeOnPick) setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[260px] p-0">
        <Command loop filter={(value, search) => (value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
          <div className="flex items-center gap-2 border-b border-line-soft px-3">
            <TagIcon className="size-4 text-ink-3" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              autoFocus
              placeholder="Find or create a tag…"
              className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-3 focus-visible:outline-none"
            />
          </div>
          <Command.List className="max-h-[260px] overflow-y-auto p-1">
            {(tags ?? []).map((t) => {
              const on = selected.includes(t.id);
              return (
                <Command.Item
                  key={t.id}
                  value={t.name}
                  onSelect={() => toggle(t.id, !on)}
                  className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none data-[selected=true]:bg-hover"
                >
                  <span className="text-ink-3">#</span>
                  <span className="flex-1 truncate">{t.name}</span>
                  {on ? <Check className="size-3.5 text-accent" /> : null}
                </Command.Item>
              );
            })}
            {clean && !exists ? (
              <Command.Item
                value={`create ${clean}`}
                onSelect={() =>
                  create.mutate(clean, {
                    onSuccess: (t) => {
                      toggle(t.id, true);
                      setQuery("");
                    },
                  })
                }
                className={cn(
                  "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none data-[selected=true]:bg-hover",
                  create.isPending && "opacity-50",
                )}
              >
                <Plus className="size-3.5 text-ink-3" />
                Create <span className="font-medium">#{clean}</span>
              </Command.Item>
            ) : null}
            {!clean && !(tags ?? []).length ? <p className="px-3 py-5 text-center text-sm text-ink-3">Type to create your first tag.</p> : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
