// 验证扫描品控闭环
const V2_BASE = "http://localhost:3000";
const V3_BASE = "http://localhost:3100";
const V2_API_KEY = "v2key_dev_b3f1a9c7e2045d6a8e9f1b2c3d4e5f6a7b8c9d0e1f2a3b4c";

async function safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 200) }; }
}

async function main() {
  // 1. 获取 V2 运单列表
  const listResp = await fetch(`${V2_BASE}/api/v1/shipments?pageSize=5`, {
    headers: { "X-API-Key": V2_API_KEY, "X-Request-ID": "req-list-scan-test" },
  });
  const listData = await safeJson(listResp);
  const shipmentId = listData.data?.items?.[0]?.id;
  console.log(`[1] V2 运单列表: ${listResp.status}, ID=${shipmentId}`);
  if (!shipmentId) { console.error("无可用 V2 运单"); return; }

  // 2. 获取运单详情和 SKU
  const lookupResp = await fetch(`${V2_BASE}/api/v1/shipments/lookup?shipmentId=${shipmentId}`, {
    headers: { "X-API-Key": V2_API_KEY, "X-Request-ID": "req-lookup-scan" },
  });
  const lookupData = await safeJson(lookupResp);
  const skuCode = lookupData.data?.items?.[0]?.skuCode;
  const skuQty = Number(lookupData.data?.items?.[0]?.skuQuantity ?? 1);
  const skuSpec = lookupData.data?.items?.[0]?.skuSpec ?? "";
  console.log(`[2] V2 运单详情: ${lookupResp.status}, SKU=${skuCode}, qty=${skuQty}, spec=${skuSpec}`);

  // 3. 登录仓管员老李
  const loginResp = await fetch(`${V3_BASE}/api/auth/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "400d58ec-a2dd-4dce-b81e-f7dbe95d15e4" }),
  });
  const setCookie = loginResp.headers.get("set-cookie");
  const loginUser = await safeJson(loginResp);
  console.log(`[3] 登录仓管员: ${loginResp.status} user=${loginUser.name ?? loginUser.id}`);

  // 4. 测试品控通过扫描（数量一致）
  const passBatch = `TEST-PASS-${Date.now()}`;
  const scanPassResp = await fetch(`${V3_BASE}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: setCookie },
    body: JSON.stringify({
      shipmentId, skuCode, actualQuantity: skuQty, skuSpec, batchNo: passBatch,
    }),
  });
  const scanPass = await safeJson(scanPassResp);
  console.log(`[4] 扫描通过: ${scanPassResp.status} qcResult=${scanPass.data?.qcResult} status=${scanPass.data?.qcStatus}`);

  // 5. 测试品控异常扫描（数量差异大）
  const failBatch = `TEST-FAIL-${Date.now()}`;
  const scanFailResp = await fetch(`${V3_BASE}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: setCookie },
    body: JSON.stringify({
      shipmentId, skuCode, actualQuantity: skuQty + 100, batchNo: failBatch, description: "数量严重不符",
    }),
  });
  const scanFail = await safeJson(scanFailResp);
  console.log(`[5] 扫描异常: ${scanFailResp.status} qcResult=${scanFail.data?.qcResult} status=${scanFail.data?.qcStatus} ticket=${scanFail.data?.ticketNo} rule=${scanFail.data?.matchedRule} severity=${scanFail.data?.severity}`);

  // 6. 测试扫描幂等（同批次重复扫描）
  const scanIdemResp = await fetch(`${V3_BASE}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: setCookie },
    body: JSON.stringify({
      shipmentId, skuCode, actualQuantity: skuQty + 50, batchNo: failBatch, description: "重复扫描",
    }),
  });
  const scanIdem = await safeJson(scanIdemResp);
  console.log(`[6] 扫描幂等: ${scanIdemResp.status} idempotent=${scanIdem.data?.idempotent} msg=${scanIdem.data?.message}`);

  // 7. 测试 QC 规则列表
  const qcRulesResp = await fetch(`${V3_BASE}/api/rules/qc`, {
    headers: { Cookie: setCookie },
  });
  const qcRules = await safeJson(qcRulesResp);
  console.log(`[7] QC规则列表: ${qcRulesResp.status} count=${qcRules.data?.length ?? 0}`);

  // 8. 测试超时任务
  const timeoutResp = await fetch(`${V3_BASE}/api/jobs/timeout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: setCookie },
  });
  const timeoutResult = await safeJson(timeoutResp);
  console.log(`[8] 超时任务: ${timeoutResp.status} processed=${timeoutResult.data?.processed}`);

  // 9. 品控主管快速放行
  const qcLoginResp = await fetch(`${V3_BASE}/api/auth/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "731b23fa-d80d-4871-bd23-175b5a05715e" }),
  });
  const qcCookie = qcLoginResp.headers.get("set-cookie");
  const qcUser = await safeJson(qcLoginResp);
  console.log(`[9] 登录品控主管: ${qcLoginResp.status} user=${qcUser.name ?? qcUser.id}`);

  if (scanFail.data?.ticketId) {
    const releaseResp = await fetch(`${V3_BASE}/api/tickets/${scanFail.data.ticketId}/quick-release`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: qcCookie, "Idempotency-Key": `qr-${Date.now()}` },
      body: JSON.stringify({ reason: "复核为扫描误判，实物数量与运单一致", expectedVersion: 1 }),
    });
    const releaseResult = await safeJson(releaseResp);
    console.log(`[10] 快速放行: ${releaseResp.status} to=${releaseResult.data?.toStatus} msg=${releaseResult.data?.message ?? releaseResult.message ?? releaseResult.code}`);
  }

  // 10. 验证 dashboard
  const dashResp = await fetch(`${V3_BASE}/api/dashboard`, {
    headers: { Cookie: qcCookie },
  });
  const dash = await safeJson(dashResp);
  console.log(`[11] 仪表盘: ${dashResp.status} todayNew=${dash.data?.todayNew} qcHoldCount=${dash.data?.qcHoldCount}`);

  console.log("\n✓ 扫描品控闭环验证完成！");
}

main().catch((e) => { console.error(e); process.exit(1); });
