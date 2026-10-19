
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { db, pool } from "../src/db/index.js";
import { accounts, plans, users, monthlyUsage } from "../src/db/schema.js";

let apiKey = "";
let accountId = "";
let userId = "";
let accountPlanId = "";
let userPlanId = "";

function currentMonth(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

async function readUsage() {
    const [accountRow] = await db
        .select({ consumedUnits: monthlyUsage.consumedUnits })
        .from(monthlyUsage)
        .where(
            and(
                eq(monthlyUsage.accountId, accountId),
                isNull(monthlyUsage.userId),
                eq(monthlyUsage.usageMonth, currentMonth()),
            ),
        )
        .limit(1);

    const [userRow] = await db
        .select({ consumedUnits: monthlyUsage.consumedUnits })
        .from(monthlyUsage)
        .where(
            and(
                eq(monthlyUsage.accountId, accountId),
                eq(monthlyUsage.userId, userId),
                eq(monthlyUsage.usageMonth, currentMonth()),
            ),
        )
        .limit(1);

    return {
        account: accountRow?.consumedUnits ?? 0,
        user: userRow?.consumedUnits ?? 0,
    };
}

beforeAll(async () => {
    const [accountPlan] = await db
        .insert(plans)
        .values({
            name: `Test Account ${randomUUID()}`,
            scope: "account",
            monthlyLimit: 5,
            maxUnitsPerRequest: 3,
        })
        .returning({ id: plans.id });

    accountPlanId = accountPlan.id;

    const [userPlan] = await db
        .insert(plans)
        .values({
            name: `Test User ${randomUUID()}`,
            scope: "user",
            monthlyLimit: 4,
            maxUnitsPerRequest: 3,
        })
        .returning({ id: plans.id });

    userPlanId = userPlan.id;

    apiKey = `um_test_${randomBytes(32).toString("hex")}`;

    const [account] = await db
        .insert(accounts)
        .values({
            name: "Quota Limit Test Account",
            apiKeyHash: createHash("sha256").update(apiKey).digest("hex"),
            apiKeyPrefix: apiKey.slice(0, 11),
            planId: accountPlanId,
        })
        .returning({ id: accounts.id });

    accountId = account.id;

    const [user] = await db
        .insert(users)
        .values({
            accountId,
            name: "Quota Limit Test User",
            externalId: `quota-test-${randomUUID()}`,
            planId: userPlanId,
        })
        .returning({ id: users.id });

    userId = user.id;
});

describe("Quota limit enforcement", () => {
    it("accepts usage within both limits and updates the database", async () => {
        const response = await request(app)
            .post("/api/v1/consumption")
            .set("X-API-Key", apiKey)
            .set("Idempotency-Key", `accepted-${randomUUID()}`)
            .send({ userId, units: 3 });

        expect(response.status).toBe(200);
        expect(response.body.outcome).toBe("accepted");
        expect(response.body.account.used).toBe(3);
        expect(response.body.user.used).toBe(3);

        await expect(readUsage()).resolves.toEqual({
            account: 3,
            user: 3,
        });
    });

    it("rejects consumption that exceeds the user's monthly quota without changing usage", async () => {
        const response = await request(app)
            .post("/api/v1/consumption")
            .set("X-API-Key", apiKey)
            .set("Idempotency-Key", `user-monthly-${randomUUID()}`)
            .send({ userId, units: 2 });

        expect(response.status).toBe(200);
        expect(response.body.outcome).toBe("rejected");
        expect(response.body.rejectionReason).toBe("USER_MONTHLY_LIMIT_EXCEEDED");

        await expect(readUsage()).resolves.toEqual({
            account: 3,
            user: 3,
        });
    });

    it("rejects consumption that exceeds the account monthly quota without changing usage", async () => {
        const response = await request(app)
            .post("/api/v1/consumption")
            .set("X-API-Key", apiKey)
            .set("Idempotency-Key", `account-monthly-${randomUUID()}`)
            .send({ userId, units: 3 });

        expect(response.status).toBe(200);
        expect(response.body.outcome).toBe("rejected");
        expect(response.body.rejectionReason).toBe("ACCOUNT_MONTHLY_LIMIT_EXCEEDED");

        await expect(readUsage()).resolves.toEqual({
            account: 3,
            user: 3,
        });
    });

    it("rejects a request above the account per-request limit without changing usage", async () => {
        const response = await request(app)
            .post("/api/v1/consumption")
            .set("X-API-Key", apiKey)
            .set("Idempotency-Key", `request-limit-${randomUUID()}`)
            .send({ userId, units: 4 });

        expect(response.status).toBe(200);
        expect(response.body.outcome).toBe("rejected");
        expect(response.body.rejectionReason).toBe("ACCOUNT_REQUEST_LIMIT_EXCEEDED");

        await expect(readUsage()).resolves.toEqual({
            account: 3,
            user: 3,
        });
    });
});

afterAll(async () => {
    try {
        if (accountId) {
            await db.delete(accounts).where(eq(accounts.id, accountId));
        }

        const planIds = [accountPlanId, userPlanId].filter(Boolean);

        if (planIds.length > 0) {
            await db.delete(plans).where(inArray(plans.id, planIds));
        }
    } finally {
        await pool.end();
    }
});
