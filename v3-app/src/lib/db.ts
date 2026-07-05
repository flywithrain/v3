import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./db-schema";

// 在 Node（非 Edge）环境，@neondatabase/serverless 的 Pool 走 WebSocket。
// 若平台未提供全局 WebSocket，则尝试按需加载 ws。本地 Node 24+ 已内置 WebSocket 全局。
if (!globalThis.WebSocket) {
  try {
    // 用 eval 触发运行时 require，避免打包器静态解析为依赖（ws 为可选依赖）。
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynReq = new Function("m", "return eval('require')(m)") as (m: string) => unknown;
    neonConfig.webSocketConstructor = dynReq("ws") as typeof neonConfig.webSocketConstructor;
  } catch {
    console.warn("[db] 当前环境无全局 WebSocket 且未安装 ws，事务可能不可用");
  }
}

type Db = NeonDatabase<typeof schema>;

let _db: Db | null = null;
let _pool: Pool | null = null;

function ensure(): { db: Db; pool: Pool } {
  if (_db && _pool) return { db: _db, pool: _pool };
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 未设置：请确认 .env.local 存在且已配置 V3 独立 Neon 连接串。"
    );
  }
  _pool = new Pool({ connectionString: url });
  _db = drizzle({ client: _pool, schema });
  return { db: _db, pool: _pool };
}

function getDb(): Db {
  return ensure().db;
}

/** 关闭连接池（脚本退出/热更新时调用）。 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

// 导出代理：兼容 `import { db } from "@/lib/db"` 的写法，懒加载真实实例
export const db = new Proxy({} as Db, {
  get(_t, prop) {
    const d = getDb();
    // @ts-expect-error 代理转发属性至真实 db 实例
    const v = d[prop];
    return typeof v === "function" ? v.bind(d) : v;
  },
}) as Db;
