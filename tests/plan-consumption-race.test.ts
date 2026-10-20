import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { app } from "../src/app.js";
import { db, pool } from "../src/db/index.js";
import { accounts, plans, users, monthlyUsage } from "../src/db/schema.js";

let apiKey = "";
let accountId = "";
let userId = "";
let planId = "";

beforeAll(async () => {
  const key = `um_test_${randomBytes(32).toString("hex")}`;

  // Find the default account plan so we can create the test account.
  const [accountPlan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(
      and(
        eq(plans.name, "Starter"),
        eq(plans.scope, "account"),
        isNull(plans.ownerAccountId),
      ),
    )
    .limit(1);

  if (!accountPlan) {
    throw new Error(
      "Starter account plan not found. Run npm run db:seed first.",
    );
  }

  // Find the default user plan.
  const [userPlan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(
      and(
        eq(plans.name, "Basic"),
        eq(plans.scope, "user"),
        isNull(plans.ownerAccountId),
      ),
    )
    .limit(1);

  if (!userPlan) {
    throw new Error(
      "Basic user plan not found. Run npm run db:seed first.",
    );
  }

  // Create the account with its default plan first.
  const [account] = await db
    .insert(accounts)
    .values({
      name: `Race Test ${randomUUID()}`,
      apiKeyHash: createHash("sha256").update(key).digest("hex"),
      apiKeyPrefix: key.slice(0, 11),
      planId: accountPlan.id,
    })
    .returning({ id: accounts.id });

  accountId = account.id;
  apiKey = key;

  // Create an account-owned custom plan through the API.
  // The API automatically sets ownerAccountId to this account.
  const planResponse = await request(app)
    .post("/api/v1/plans")
    .set("X-API-Key", apiKey)
    .send({
      name: `Race Account ${randomUUID()}`,
      scope: "account",
      monthlyLimit: 5,
      maxUnitsPerRequest: 3,
    });

  expect(planResponse.status).toBe(201);
  planId = planResponse.body.plan.id;

  // Assign the custom plan to the test account.
  const assignment = await request(app)
    .patch("/api/v1/accounts/plan")
    .set("X-API-Key", apiKey)
    .send({ planId });

  expect(assignment.status).toBe(200);

  // Create a test user with the default Basic user plan.
  const [user] = await db
    .insert(users)
    .values({
      accountId,
      name: "Race Test User",
      externalId: `race-${randomUUID()}`,
      planId: userPlan.id,
    })
    .returning({ id: users.id });

  userId = user.id;
});

describe("Plan update and consumption concurrency", () => {
  it("uses a consistent plan limit when consumption races with a limit reduction", async () => {
    const requestId = randomUUID();

    const [consumption, update] = await Promise.all([
      request(app)
        .post("/api/v1/consumption")
        .set("X-API-Key", apiKey)
        .set("Idempotency-Key", requestId)
        .send({ userId, units: 2 }),

      request(app)
        .patch(`/api/v1/plans/${planId}`)
        .set("X-API-Key", apiKey)
        .send({ monthlyLimit: 1 }),
    ]);

    expect(update.status).toBe(200);
    expect(consumption.status).toBe(200);

    const snapshot = consumption.body;

    if (snapshot.outcome === "accepted") {
      // Consumption acquired the account lock before the plan update.
      expect(snapshot.account.limit).toBe(5);
      expect(snapshot.account.used).toBe(2);
      expect(snapshot.account.remaining).toBe(3);
    } else {
      // The plan update acquired the account lock first.
      expect(snapshot.outcome).toBe("rejected");
      expect(snapshot.rejectionReason).toBe(
        "ACCOUNT_MONTHLY_LIMIT_EXCEEDED",
      );
      expect(snapshot.account.limit).toBe(1);
      expect(snapshot.account.used).toBe(0);
      expect(snapshot.account.remaining).toBe(1);
    }

    // Verify persisted account-level usage matches the outcome.
    const [storedUsage] = await db
      .select({ consumedUnits: monthlyUsage.consumedUnits })
      .from(monthlyUsage)
      .where(
        and(
          eq(monthlyUsage.accountId, accountId),
          isNull(monthlyUsage.userId),
        ),
      )
      .limit(1);

    expect(storedUsage?.consumedUnits ?? 0).toBe(
      snapshot.outcome === "accepted" ? 2 : 0,
    );
  });
});

afterAll(async () => {
  try {
    if (accountId) {
      await db.delete(accounts).where(eq(accounts.id, accountId));
    }

    if (planId) {
      await db.delete(plans).where(eq(plans.id, planId));
    }
  } finally {
    await pool.end();
  }
});

