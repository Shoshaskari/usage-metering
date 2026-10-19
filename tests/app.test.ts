import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db, pool } from "../src/db/index.js";
import { accounts, plans, users } from "../src/db/schema.js";

let testApiKey = "";
let testAccountId = "";
let testUserId = "";

beforeAll(async () => {
  const [accountPlan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.name, "Starter"), eq(plans.scope, "account")))
    .limit(1);

  const [userPlan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.name, "Basic"), eq(plans.scope, "user")))
    .limit(1);

  if (!accountPlan || !userPlan) {
    throw new Error("Test plans not found. Run npm run db:seed first.");
  }

  testApiKey = `um_test_${randomBytes(32).toString("hex")}`;

  const [account] = await db
    .insert(accounts)
    .values({
      name: "Automated Test Account",
      apiKeyHash: createHash("sha256").update(testApiKey).digest("hex"),
      apiKeyPrefix: testApiKey.slice(0, 11),
      planId: accountPlan.id,
    })
    .returning({ id: accounts.id });

  testAccountId = account.id;

  const [user] = await db
    .insert(users)
    .values({
      accountId: testAccountId,
      name: "Automated Test User",
      externalId: `vitest-${randomUUID()}`,
      planId: userPlan.id,
    })
    .returning({ id: users.id });

  testUserId = user.id;
});

describe("Usage Metering API", () => {
  it("returns healthy status from /healthz", async () => {
    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "usage-metering",
    });
  });

  it("rejects consumption requests without an API key", async () => {
    const response = await request(app)
      .post("/api/v1/consumption")
      .send({ userId: randomUUID(), units: 1 });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("API_KEY_REQUIRED");
  });

  it("rejects usage requests without an API key", async () => {
    const response = await request(app).get("/api/v1/usage");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("API_KEY_REQUIRED");
  });

  it("returns 404 for an unknown endpoint", async () => {
    const response = await request(app).get("/this-route-does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns ready status when the database is connected", async () => {
    const response = await request(app).get("/readyz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ready",
      database: "connected",
    });
  });

  it("rejects an invalid API key", async () => {
    const response = await request(app)
      .get("/api/v1/usage")
      .set("X-API-Key", "invalid-test-key");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_API_KEY");
  });

  it("rejects consumption when units is zero", async () => {
    const response = await request(app)
      .post("/api/v1/consumption")
      .set("X-API-Key", testApiKey)
      .set("Idempotency-Key", `zero-${randomUUID()}`)
      .send({ userId: testUserId, units: 0 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects consumption when the idempotency key is missing", async () => {
    const response = await request(app)
      .post("/api/v1/consumption")
      .set("X-API-Key", testApiKey)
      .send({ userId: testUserId, units: 1 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
  });
});

afterAll(async () => {
  try {
    if (testAccountId) {
      await db.delete(accounts).where(eq(accounts.id, testAccountId));
    }
  } finally {
    await pool.end();
  }
});
