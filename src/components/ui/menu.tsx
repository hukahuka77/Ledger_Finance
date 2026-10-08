"use client";

import * as M from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/cn";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ className, align = "end", ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          "z-50 min-w-[200px] rounded-lg border border-line bg-surface p-1 text-sm text-ink shadow-[0_6px_24px_-8px_rgba(60,50,40,0.18)]",
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({ className, danger, ...props }: React.ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return (
    <M.Item
      className={cn(
        "flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-ink-2",
        danger && "text-brick [&_svg]:text-brick",
        className,
      )}
      {...props}
    />
  );
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-line-soft" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <M.Label className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-ink-3 uppercase">{children}</M.Label>;
}
