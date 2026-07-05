"use client";

import { ShieldAlert } from "lucide-react";

export default function QcRulesPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-6 w-6 text-[var(--color-primary)]" />
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">品控规则引擎</h1>
      </header>
      <div className="alert alert-info">
        品控规则引擎（qc_rules、scan_records、品控批次状态机）属于
        <b> 后续轮次</b> 交付范围。当前仅开放 <b>审批规则</b>（<a href="/rules/approval" className="underline">前往</a>）。
      </div>
    </div>
  );
}
