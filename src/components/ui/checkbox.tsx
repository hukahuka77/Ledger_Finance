"use client";

import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  className,
  disabled,
  title,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean, e: React.MouseEvent) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const on = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked, e);
      }}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        on ? "border-accent bg-accent text-white" : "border-[#cbc6bc] bg-surface hover:border-ink-3",
        className,
      )}
    >
      {indeterminate ? <Minus className="size-3" strokeWidth={3} /> : checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line bg-line-soft",
      )}
    >
      <span
        className={cn(
          "inline-block size-3.5 rounded-full bg-white shadow-[0_1px_1px_rgba(0,0,0,0.15)] transition-transform",
          checked ? "translate-x-[15px]" : "translate-x-[1px]",
        )}
      />
    </button>
  );
}
