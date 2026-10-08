import Image from "next/image";
import { cn } from "@/lib/cn";

/** Ledger mark + wordmark. Height is set by className (e.g. "h-7"); width follows the aspect ratio. */
export function Logo({ className, priority }: { className?: string; priority?: boolean }) {
  return <Image src="/logo.png" alt="Ledger Finance" width={424} height={104} priority={priority} className={cn("h-7 w-auto", className)} />;
}
