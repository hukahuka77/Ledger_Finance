"use client";

import * as D from "@radix-ui/react-dialog";
import { CalendarDays, Layers, LayoutDashboard, Menu, WalletCards } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/layout/logo";
import { Sidebar } from "@/components/layout/sidebar";
import { useWorkspace, WorkspaceProvider } from "@/components/layout/workspace-provider";
import { cn } from "@/lib/cn";
import { useMounted } from "@/lib/hooks/use-mounted";
import { usePlaidAutoSync } from "@/lib/queries/plaid";

const MOBILE_NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/transactions", label: "Ledger", icon: Layers },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/accounts", label: "Accounts", icon: WalletCards },
];

function PlaidAutoSync() {
  usePlaidAutoSync();
  return null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  // All finance data is fetched client-side (RLS-scoped) and dates render in the
  // viewer's timezone, so the shell renders after mount to avoid hydration drift.
  const mounted = useMounted();
  if (!mounted) return <div className="h-dvh bg-paper" />;
  return (
    <WorkspaceProvider>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  const { canEdit } = useWorkspace();

  return (
    <div className="flex h-dvh overflow-hidden bg-paper print:block print:h-auto print:overflow-visible">
      <PlaidAutoSync />
      {/* Desktop: persistent sidebar */}
      <aside className="hidden w-[248px] shrink-0 border-r border-line lg:block print:hidden">
        <Sidebar />
      </aside>

      {/* Tablet & mobile: slide-over sidebar */}
      <D.Root open={drawer} onOpenChange={setDrawer}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-[#2c2926]/25 lg:hidden" />
          <D.Content className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] border-r border-line shadow-xl outline-none lg:hidden">
            <D.Title className="sr-only">Navigation</D.Title>
            <D.Description className="sr-only">Main navigation and accounts</D.Description>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>

      <div className="flex min-w-0 flex-1 flex-col print:block">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-sidebar px-3 lg:hidden print:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setDrawer(true)}
            className="inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-hover"
          >
            <Menu className="size-5" strokeWidth={1.75} />
          </button>
          <Link href="/dashboard" aria-label="Ledger Finance home">
            <Logo className="h-6" />
          </Link>
        </header>

        {canEdit ? null : (
          <p className="shrink-0 border-b border-line bg-[#f5ecd8] px-4 py-1.5 text-center text-[12.5px] text-ink-2 print:hidden">
            View only: you can look at everything in this workspace but not change it.
          </p>
        )}
        <main className="min-h-0 flex-1">{children}</main>

        <nav
          aria-label="Primary"
          className="grid h-14 shrink-0 grid-cols-4 border-t border-line bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
        >
          {MOBILE_NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={cn("flex flex-col items-center justify-center gap-0.5 text-[11px]", active ? "text-accent" : "text-ink-2")}
              >
                <Icon className="size-[18px]" strokeWidth={1.75} />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

/** Standard scrolling page body with editorial spacing. */
export function Page({ children, className, wide }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto print:h-auto print:overflow-visible">
      <div className={cn("mx-auto px-4 py-6 sm:px-8 sm:py-8", wide ? "max-w-6xl" : "max-w-5xl", className)}>{children}</div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 sm:mb-8">
      <div className="min-w-0">
        <h1 className="font-serif text-[26px] leading-tight text-ink sm:text-[28px]">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-2">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeading({ children, actions, className }: { children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3 border-b border-line pb-2", className)}>
      <h2 className="text-[17px] font-medium text-ink">{children}</h2>
      {actions}
    </div>
  );
}
