"use client";

import { CalendarDays, ChartPie, ChevronRight, Layers, LayoutDashboard, LogOut, Repeat, Settings, Shapes, WalletCards } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/layout/logo";
import { useWorkspace } from "@/components/layout/workspace-provider";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { ACCOUNT_TYPES, type Account, type AccountType } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { useAccounts } from "@/lib/queries/reference";
import { useUnreviewedCount } from "@/lib/queries/transactions";
import { getSupabase } from "@/lib/supabase/client";

export const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: Layers },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/accounts", label: "Accounts", icon: WalletCards },
  { href: "/categories", label: "Categories", icon: Shapes },
  { href: "/recurring", label: "Recurring", icon: Repeat },
  { href: "/reports", label: "Reports", icon: ChartPie },
] as const;

const GROUP_ORDER: AccountType[] = ["credit_card", "checking", "savings", "brokerage", "retirement", "cash", "loan", "mortgage", "other"];
const COLLAPSE_KEY = "ledger.sidebar.collapsed";

function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate UI preference after mount
      if (raw) setCollapsed(JSON.parse(raw));
    } catch {
      /* preference only */
    }
  }, []);
  const toggle = (t: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t];
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* preference only */
      }
      return next;
    });
  return { collapsed, toggle };
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: accounts, isLoading } = useAccounts();
  const { data: unreviewed } = useUnreviewedCount();
  const { collapsed, toggle } = useCollapsedGroups();
  const { isBusiness } = useWorkspace();

  const groups = useMemo(() => {
    const active = (accounts ?? []).filter((a) => a.active);
    return GROUP_ORDER.map((type) => ({
      type,
      accounts: active.filter((a) => a.account_type === type).sort((a, b) => Math.abs(b.current_balance) - Math.abs(a.current_balance)),
    })).filter((g) => g.accounts.length);
  }, [accounts]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar">
      <div className="flex h-14 shrink-0 items-center px-5">
        <Link href="/dashboard" onClick={onNavigate} aria-label="Ledger Finance home" className="rounded-md outline-offset-4">
          <Logo className="h-7" priority />
        </Link>
      </div>
      <div className="shrink-0 px-3 pb-3">
        <WorkspaceSwitcher onNavigate={onNavigate} />
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <ul className="space-y-0.5">
          {NAV.map(({ href, label: personalLabel, icon: Icon }) => {
            // Business workspaces call their categories a chart of accounts.
            const label = isBusiness && href === "/categories" ? "Chart of accounts" : personalLabel;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[14px] transition-colors",
                    active ? "bg-selected font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
                  )}
                >
                  <Icon className={cn("size-4", active ? "text-accent" : "text-ink-3")} strokeWidth={1.75} />
                  <span className="flex-1">{label}</span>
                  {href === "/transactions" && unreviewed ? (
                    <span className="tabular text-[12px] font-medium text-accent" title={`${unreviewed} unreviewed`}>
                      {unreviewed.toLocaleString()}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="mt-7">
          <div className="flex items-center justify-between px-2.5 pb-1.5">
            <Link href="/accounts" onClick={onNavigate} className="text-[11.5px] font-bold tracking-[0.08em] text-ink uppercase hover:text-accent">
              Accounts
            </Link>
          </div>
          {isLoading ? (
            <div className="space-y-2 px-2.5 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <p className="px-2.5 text-[13px] text-ink-3">
              No accounts yet.{" "}
              <Link href="/settings/import" onClick={onNavigate} className="text-accent hover:underline">
                Import a CSV
              </Link>
            </p>
          ) : (
            groups.map((g) => {
              const isCollapsed = collapsed.includes(g.type);
              const total = g.accounts.reduce((s, a) => s + a.current_balance, 0);
              return (
                <div key={g.type} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggle(g.type)}
                    aria-expanded={!isCollapsed}
                    className="flex h-7 w-full items-center gap-1 rounded-md px-2.5 text-[13px] font-semibold text-ink hover:bg-hover"
                  >
                    <ChevronRight className={cn("size-3.5 text-ink-2 transition-transform", !isCollapsed && "rotate-90")} />
                    <span className="flex-1 text-left">{ACCOUNT_TYPES[g.type]}</span>
                    {isCollapsed ? <span className="tabular text-[12px] text-ink-3">{formatMoney(total, { cents: false })}</span> : null}
                  </button>
                  {!isCollapsed ? (
                    <ul>
                      {g.accounts.map((a) => (
                        <AccountLink key={a.id} account={a} active={pathname === `/accounts/${a.id}`} onNavigate={onNavigate} />
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2">
        <Link
          href="/settings"
          onClick={onNavigate}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[14px] transition-colors",
            pathname.startsWith("/settings") ? "bg-selected font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
          )}
        >
          <Settings className="size-4 text-ink-3" strokeWidth={1.75} />
          Settings
        </Link>
        <button
          type="button"
          onClick={signOut}
          className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[14px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <LogOut className="size-4 text-ink-3" strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </nav>
  );
}

function AccountLink({ account, active, onNavigate }: { account: Account; active: boolean; onNavigate?: () => void }) {
  return (
    <li>
      <Link
        href={`/accounts/${account.id}`}
        onClick={onNavigate}
        className={cn(
          "flex h-7 items-center gap-2 rounded-md pr-2.5 pl-7 text-[13px] transition-colors",
          active ? "bg-selected text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{account.name}</span>
        <span className="tabular shrink-0 text-[12.5px] text-ink-3" title={account.balance_as_of ? undefined : "Balance not set"}>
          {account.current_balance === 0 && !account.balance_as_of ? "—" : formatMoney(account.current_balance, { cents: false })}
        </span>
      </Link>
    </li>
  );
}
