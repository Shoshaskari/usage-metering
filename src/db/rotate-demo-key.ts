import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool } from "./index.js";
import { accounts } from "./schema.js";

async function main() {
  const accountId = "e0c0c7ae-605b-4897-91fd-ae9cecf8ed15";
  const newApiKey = `um_${randomBytes(32).toString("hex")}`;
  const apiKeyHash = createHash("sha256")
    .update(newApiKey)
    .digest("hex");

  const updated = await db
    .update(accounts)
    .set({
      apiKeyHash,
      apiKeyPrefix: newApiKey.slice(0, 11),
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id });

  if (updated.length === 0) {
    throw new Error("Account not found; no key was changed.");
  }

  console.log("API key rotated successfully.");
  console.log("Account ID:", updated[0].id);
  console.log("NEW API KEY (save it securely):", newApiKey);
}

try {
  await main();
} catch (error) {
  console.error("Key rotation failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
