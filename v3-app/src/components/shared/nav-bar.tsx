"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  ScanLine,
  Ticket,
  CheckSquare,
  Settings,
  Network,
  Boxes,
  ChevronDown,
  LogOut,
  User as UserIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession, ROLE_LABELS, apiFetch } from "./auth-context";

interface UserOption {
  id: string;
  name: string;
  roleCodes: string[];
}

const navItems = [
  { href: "/", label: "首页", icon: LayoutDashboard },
  { href: "/scan", label: "扫描", icon: ScanLine },
  { href: "/tickets", label: "工单", icon: Ticket },
  { href: "/approvals", label: "待审批", icon: CheckSquare },
  { href: "/rules/approval", label: "规则", icon: Settings },
  { href: "/integrations", label: "接口监控", icon: Network },
  { href: "/inventory", label: "库存", icon: Boxes },
];

export function NavBar() {
  const pathname = usePathname();
  const { user, switchUser, logout } = useSession();
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    apiFetch<UserOption[]>("/api/users")
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [open]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-14 bg-[#0fc6c2] shadow-md">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-white no-underline">
          <Ticket className="h-6 w-6 flex-shrink-0" />
          <span className="text-base font-bold tracking-wide sm:text-lg">运单异常管理 V3</span>
        </Link>

        <div className="flex items-center gap-0.5 sm:gap-1">
          {navItems.map((item) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm font-medium transition-all duration-200 no-underline sm:px-3",
                  isActive
                    ? "bg-white/20 text-white"
                    : "text-white/80 hover:bg-white/10 hover:text-white"
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="hidden md:inline">{item.label}</span>
              </Link>
            );
          })}
        </div>

        <div className="relative" ref={ref}>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 rounded-md bg-white/15 px-2.5 py-1.5 text-sm text-white transition-colors hover:bg-white/25"
          >
            <UserIcon className="h-4 w-4" />
            <span className="hidden sm:inline">
              {user ? user.name : "未登录"}
              {user && user.roleCodes.length > 0 && (
                <span className="ml-1 text-xs text-white/70">
                  ({user.roleCodes.map((r) => ROLE_LABELS[r] ?? r).join(", ")})
                </span>
              )}
            </span>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>

          {open && (
            <div className="absolute right-0 top-full mt-1 w-72 rounded-md border border-[var(--color-border)] bg-white p-2 shadow-lg animate-fade-in">
              <div className="px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)]">
                模拟切换角色（写 cookie）
              </div>
              <div className="max-h-80 overflow-y-auto">
                {users.length === 0 && (
                  <div className="px-3 py-3 text-sm text-[var(--color-text-muted)]">加载中…</div>
                )}
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => switchUser(u.id).then(() => setOpen(false)).catch(() => {})}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors",
                      user?.id === u.id
                        ? "bg-[var(--color-primary-light)] text-[var(--color-primary-dark)]"
                        : "hover:bg-[var(--color-bg-subtle)]"
                    )}
                  >
                    <span>{u.name}</span>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {u.roleCodes.map((r) => ROLE_LABELS[r] ?? r).join(", ")}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-1 border-t border-[var(--color-border-light)] pt-1">
                <button
                  onClick={() => {
                    logout();
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-subtle)]"
                >
                  <LogOut className="h-4 w-4" /> 退出登录
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
