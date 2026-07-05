"use client";

import { ScanLine } from "lucide-react";

export default function ScanPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex items-center gap-2">
        <ScanLine className="h-6 w-6 text-[var(--color-primary)]" />
        <h1 className="text-xl font-bold text-[var(--color-text-main)]">扫描品控</h1>
      </header>
      <div className="alert alert-info">
        本功能（扫码 SKU 归属校验、品控批次状态机 qc_hold、误判快速放行）属于
        <b> 后续轮次</b> 交付范围，本轮暂未实现。
        当前可正常使用 <b>人工物流异常上报</b> 与 <b>分级审批</b> 主闭环。
      </div>
    </div>
  );
}
