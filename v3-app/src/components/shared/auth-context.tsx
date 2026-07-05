"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

export interface CurrentUser {
  id: string;
  name: string;
  roleCodes: string[];
}

export interface ServerError {
  code: string;
  message: string;
  status?: number;
}

interface SessionContextValue {
  user: CurrentUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  switchUser: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue>({
  user: null,
  loading: true,
  refresh: async () => {},
  switchUser: async () => {},
  logout: async () => {},
});

export function useSession() {
  return useContext(SessionContext);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (!res.ok) {
        setUser(null);
        return;
      }
      const json = await res.json();
      setUser(json.data ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const switchUser = useCallback(async (userId: string) => {
    const res = await fetch("/api/auth/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as ServerError;
      throw new Error(e.message ?? "切换用户失败");
    }
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ user, loading, refresh, switchUser, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

/**
 * 统一 API 调用封装。
 * - 默认带 cache: "no-store"
 * - 解析 { data, error } 结构；error 时抛 ApiError（带 code/message/status）
 * - 支持幂等头 Idempotency-Key
 */
export class ApiError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function apiFetch<T>(
  url: string,
  opts: RequestInit & { idempotencyKey?: string } = {}
): Promise<T> {
  const { idempotencyKey, headers, ...rest } = opts;
  const finalHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  if (idempotencyKey) finalHeaders["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(url, { cache: "no-store", ...rest, headers: finalHeaders });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: ServerError; code?: string; message?: string };
  if (!res.ok) {
    // V3 错误响应：{ code, message }（顶层，来自 apiError）
    const err = json.error ?? { code: json.code ?? "UNKNOWN", message: json.message ?? `请求失败 (${res.status})` };
    throw new ApiError(err.code, err.message, res.status);
  }
  return json.data as T;
}

/** 角色中文标签 */
export const ROLE_LABELS: Record<string, string> = {
  operator: "操作员（上报）",
  warehouse_operator: "仓储操作员",
  qc_supervisor: "品控主管",
  level1_approver: "一级审批人",
  level2_approver: "二级审批人",
  admin: "管理员",
  auditor: "审计员",
};
