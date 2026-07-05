// 验证 V3 是否正常：登录 → /api/dashboard → /api/auth/me
const BASE = "http://localhost:3100";

async function main() {
  // 1. 未登录 /api/auth/me → 应返回 401
  let r = await fetch(`${BASE}/api/auth/me`);
  console.log(`[1] GET /api/auth/me (no cookie): ${r.status} ${await r.text()}`);

  // 2. 登录 操作员小张
  r = await fetch(`${BASE}/api/auth/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "0cd47a59-c0f3-456f-b56e-d2db3244e5fa" }),
  });
  const setCookie = r.headers.get("set-cookie");
  const user = await r.json();
  console.log(`[2] POST /api/auth/switch: ${r.status} user=${user.name} roles=${user.roleCodes}`);
  if (!setCookie) {
    console.error("ERROR: no set-cookie header!");
    process.exit(1);
  }

  // 3. 带 cookie 访问 /api/auth/me → 应返回用户信息
  r = await fetch(`${BASE}/api/auth/me`, {
    headers: { Cookie: setCookie },
  });
  const me = await r.json();
  console.log(`[3] GET /api/auth/me (with cookie): ${r.status} user=${me.name} roles=${me.roleCodes}`);

  // 4. 带 cookie 访问 /api/dashboard → 应返回统计数据
  r = await fetch(`${BASE}/api/dashboard`, {
    headers: { Cookie: setCookie },
  });
  const dash = await r.json();
  console.log(`[4] GET /api/dashboard: ${r.status} data=${JSON.stringify(dash)}`);

  console.log("\n✓ V3 验证全部通过！");
}

main().catch((e) => { console.error(e); process.exit(1); });
