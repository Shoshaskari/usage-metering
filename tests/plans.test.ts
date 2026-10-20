import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { app } from "../src/app.js";
import { db, pool } from "../src/db/index.js";
import { accounts, plans, users } from "../src/db/schema.js";

let apiKeyA = "";
let apiKeyB = "";
let accountA = "";
let accountB = "";
let userA = "";

async function createTestAccount(name: string) {
  const [defaultPlan] = await db
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

  if (!defaultPlan) {
    throw new Error("Starter plan not found. Run npm run db:seed first.");
  }

  const key = `um_test_${randomBytes(32).toString("hex")}`;
  const [account] = await db
    .insert(accounts)
    .values({
      name,
      apiKeyHash: createHash("sha256").update(key).digest("hex"),
      apiKeyPrefix: key.slice(0, 11),
      planId: defaultPlan.id,
    })
    .returning({ id: accounts.id });

  return { id: account.id, key };
}

beforeAll(async () => {
  const a = await createTestAccount("Custom Plan Test A");
  const b = await createTestAccount("Custom Plan Test B");

  accountA = a.id;
  apiKeyA = a.key;
  accountB = b.id;
  apiKeyB = b.key;

  const [defaultUserPlan] = await db
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

  if (!defaultUserPlan) {
    throw new Error("Basic plan not found. Run npm run db:seed first.");
  }

  const [user] = await db
    .insert(users)
    .values({
      accountId: accountA,
      name: "Custom Plan Test User",
      externalId: `plans-${randomUUID()}`,
      planId: defaultUserPlan.id,
    })
    .returning({ id: users.id });

  userA = user.id;
});

describe("Custom plans API", () => {
  it("lists default plans and only the authenticated account's custom plans", async () => {
    const created = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyA)
      .send({
        name: "Team Plus",
        scope: "user",
        monthlyLimit: 300,
        maxUnitsPerRequest: 25,
      });

    expect(created.status).toBe(201);

    const responseA = await request(app)
      .get("/api/v1/plans")
      .set("X-API-Key", apiKeyA);

    const responseB = await request(app)
      .get("/api/v1/plans")
      .set("X-API-Key", apiKeyB);

    expect(responseA.status).toBe(200);
    expect(responseA.body.plans.some((p: { id: string }) => p.id === created.body.plan.id)).toBe(true);
    expect(responseB.status).toBe(200);
    expect(responseB.body.plans.some((p: { id: string }) => p.id === created.body.plan.id)).toBe(false);
    expect(responseB.body.plans.some((p: { name: string; ownerAccountId: string | null }) =>
      p.name === "Starter" && p.ownerAccountId === null,
    )).toBe(true);
  });

  it("rejects invalid custom plan values", async () => {
    const response = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyA)
      .send({
        name: "X",
        scope: "account",
        monthlyLimit: 0,
        maxUnitsPerRequest: -1,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects duplicate custom plan names within the same account and scope", async () => {
    const payload = {
      name: "Duplicate Plan",
      scope: "user",
      monthlyLimit: 300,
      maxUnitsPerRequest: 25,
    };

    const first = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyA)
      .send(payload);

    const duplicateSameAccount = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyA)
      .send(payload);

    const sameNameOtherAccount = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyB)
      .send(payload);

    expect(first.status).toBe(201);
    expect(duplicateSameAccount.status).toBe(409);
    expect(duplicateSameAccount.body.error.code).toBe("DUPLICATE_PLAN");
    expect(sameNameOtherAccount.status).toBe(201);
  });

  it("updates its own custom plan but prevents changing a default plan or another account's plan", async () => {
    const created = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyA)
      .send({
        name: "Editable Plan",
        scope: "user",
        monthlyLimit: 300,
        maxUnitsPerRequest: 25,
      });

    expect(created.status).toBe(201);
    const planId = created.body.plan.id;

    const ownUpdate = await request(app)
      .patch(`/api/v1/plans/${planId}`)
      .set("X-API-Key", apiKeyA)
      .send({ monthlyLimit: 500 });

    const foreignUpdate = await request(app)
      .patch(`/api/v1/plans/${planId}`)
      .set("X-API-Key", apiKeyB)
      .send({ monthlyLimit: 900 });

    const [defaultPlan] = await db
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

    const defaultUpdate = await request(app)
      .patch(`/api/v1/plans/${defaultPlan.id}`)
      .set("X-API-Key", apiKeyA)
      .send({ monthlyLimit: 999 });

    expect(ownUpdate.status).toBe(200);
    expect(ownUpdate.body.plan.monthlyLimit).toBe(500);
    expect(foreignUpdate.status).toBe(404);
    expect(defaultUpdate.status).toBe(404);
  });

  it("assigns a custom user plan only to a user owned by that account", async () => {
    const created = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyA)
      .send({
        name: "Low Limit User",
        scope: "user",
        monthlyLimit: 40,
        maxUnitsPerRequest: 5,
      });

    expect(created.status).toBe(201);

    const assigned = await request(app)
      .patch(`/api/v1/users/${userA}/plan`)
      .set("X-API-Key", apiKeyA)
      .send({ planId: created.body.plan.id });

    const foreignUser = await request(app)
      .patch(`/api/v1/users/${userA}/plan`)
      .set("X-API-Key", apiKeyB)
      .send({ planId: created.body.plan.id });

    expect(assigned.status).toBe(200);
    expect(assigned.body.user.planId).toBe(created.body.plan.id);
    expect(foreignUser.status).toBe(404);
  });

  it("assigns a custom account plan and rejects plans owned by another account", async () => {
    const createdA = await request(app)
      .post("/api/v1/plans")
      .set("X-API-Key", apiKeyA)
      .send({
        name: "Custom Account Tier",
        scope: "account",
        monthlyLimit: 700,
        maxUnitsPerRequest: 30,
      });

    const assignedA = await request(app)
      .patch("/api/v1/accounts/plan")
      .set("X-API-Key", apiKeyA)
      .send({ planId: createdA.body.plan.id });

    const foreignAssignment = await request(app)
      .patch("/api/v1/accounts/plan")
      .set("X-API-Key", apiKeyB)
      .send({ planId: createdA.body.plan.id });

    expect(createdA.status).toBe(201);
    expect(assignedA.status).toBe(200);
    expect(assignedA.body.account.planId).toBe(createdA.body.plan.id);
    expect(foreignAssignment.status).toBe(404);
  });
});

afterAll(async () => {
  try {
    const ownerIds = [accountA, accountB].filter(Boolean);

    if (ownerIds.length > 0) {
      const [defaultAccountPlan] = await db
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

      const [defaultUserPlan] = await db
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

      if (!defaultAccountPlan || !defaultUserPlan) {
        throw new Error("Default plans not found during test cleanup.");
      }

      await db
        .update(accounts)
        .set({ planId: defaultAccountPlan.id })
        .where(inArray(accounts.id, ownerIds));

      await db
        .update(users)
        .set({ planId: defaultUserPlan.id })
        .where(inArray(users.accountId, ownerIds));

      await db
        .delete(plans)
        .where(inArray(plans.ownerAccountId, ownerIds));

      await db
        .delete(accounts)
        .where(inArray(accounts.id, ownerIds));
    }
  } finally {
    await pool.end();
  }
});