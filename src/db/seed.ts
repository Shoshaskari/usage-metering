import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, pool } from "./index.js";
import { plans } from "./schema.js";

const defaultPlans = [
  {
    name: "Starter",
    scope: "account" as const,
    monthlyLimit: 1000,
    maxUnitsPerRequest: 50,
  },
  {
    name: "Pro",
    scope: "account" as const,
    monthlyLimit: 10000,
    maxUnitsPerRequest: 200,
  },
  {
    name: "Basic",
    scope: "user" as const,
    monthlyLimit: 100,
    maxUnitsPerRequest: 10,
  },
  {
    name: "Premium",
    scope: "user" as const,
    monthlyLimit: 1000,
    maxUnitsPerRequest: 50,
  },
];

async function seed() {
  for (const plan of defaultPlans) {
    const existing = await db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.name, plan.name),
          eq(plans.scope, plan.scope),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      console.log(`Already exists: ${plan.name}`);
      continue;
    }

    await db.insert(plans).values(plan);
    console.log(`Created plan: ${plan.name}`);
  }
}

try {
  await seed();
} catch (error) {
  console.error("Seeding failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
