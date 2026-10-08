"use client";

import * as P from "@radix-ui/react-popover";
import { cn } from "@/lib/cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, align = "start", sideOffset = 6, ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 rounded-lg border border-line bg-surface p-3 text-sm text-ink shadow-[0_6px_24px_-8px_rgba(60,50,40,0.18)] outline-none",
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
}
