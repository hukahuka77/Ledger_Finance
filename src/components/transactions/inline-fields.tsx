"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Text that edits in place and autosaves on blur / Enter. Escape reverts.
 * Keeps local state while focused so optimistic cache updates don't fight typing.
 */
export function InlineText({
  value,
  onSave,
  className,
  placeholder,
  ariaLabel,
  maxLength = 200,
  required,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  placeholder?: string;
  ariaLabel: string;
  maxLength?: number;
  required?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : value;

  const commit = () => {
    const v = draft.trim();
    if (required && !v) {
      setDraft(value);
      return;
    }
    if (v !== value) onSave(v);
  };

  return (
    <input
      aria-label={ariaLabel}
      value={shown}
      maxLength={maxLength}
      placeholder={placeholder}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.stopPropagation();
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className={cn(
        "w-full rounded-md border border-transparent bg-transparent px-1.5 -mx-1.5 transition-colors outline-none hover:border-line focus:border-accent/50 focus:bg-surface",
        className,
      )}
    />
  );
}

/** Textarea that autosaves after a pause in typing and on blur. */
export function AutosaveTextarea({
  value,
  onSave,
  placeholder,
  ariaLabel,
  maxLength = 5000,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  ariaLabel: string;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef(value);

  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
      lastSaved.current = value;
    }
  }, [value]);

  const flush = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (v !== lastSaved.current) {
      lastSaved.current = v;
      onSave(v);
    }
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <textarea
      aria-label={ariaLabel}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(v), 900);
      }}
      onBlur={() => {
        focused.current = false;
        flush(draft);
      }}
      onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLTextAreaElement).blur()}
      className="min-h-24 w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-3 focus:border-accent/50 focus:ring-2 focus:ring-accent/15 focus:outline-none"
    />
  );
}
