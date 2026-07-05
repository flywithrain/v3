import { config } from "dotenv";
config({ path: ".env.local" });
import { db } from "../src/lib/db";
import { users } from "../src/lib/db-schema";

async function main() {
  const rows = await db
    .select({ id: users.id, name: users.name, roleCodes: users.roleCodes, enabled: users.enabled })
    .from(users)
    .orderBy(users.name);
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
