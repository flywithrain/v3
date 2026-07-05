import { config } from "dotenv";
config({ path: ".env.local" });
import { Pool } from "@neondatabase/serverless";
async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await p.query("SELECT id FROM approval_records WHERE idempotency_key = $1", ["idem_real_dup_xyz123"]);
  console.log("同 key 审批记录数:", r.rows.length);
  const comps = await p.query("SELECT count(*)::int AS n FROM compensation_records WHERE approval_record_id = $1", ["6755576a-ffcb-46b8-8a47-b1508e30aa34"]);
  console.log("同 approvalRecordId 赔付数:", comps.rows[0].n);
  const mvs = await p.query("SELECT count(*)::int AS n FROM inventory_movements WHERE approval_record_id = $1", ["6755576a-ffcb-46b8-8a47-b1508e30aa34"]);
  console.log("同 approvalRecordId 库存流水数:", mvs.rows[0].n);
  await p.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
