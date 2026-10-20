import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { app } from "../src/app.js";
import { db, pool } from "../src/db/index.js";
import { accounts, plans, users, monthlyUsage, consumptionRequests } from "../src/db/schema.js";

let apiKey = "";
let accountId = "";
let userId = "";
let accountPlanId = "";
let userPlanId = "";

function currentMonth(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

beforeAll(async () => {
    const [accountPlan] = await db
        .insert(plans)
        .values({
            name: `Concurrency Account ${randomUUID()}`,
            scope: "account",
            monthlyLimit: 5,
            maxUnitsPerRequest: 3,
        })
        .returning({ id: plans.id });

    accountPlanId = accountPlan.id;

    const [userPlan] = await db
        .insert(plans)
        .values({
            name: `Concurrency User ${randomUUID()}`,
            scope: "user",
            monthlyLimit: 10,
            maxUnitsPerRequest: 3,
        })
        .returning({ id: plans.id });

    userPlanId = userPlan.id;

    apiKey = `um_test_${randomBytes(32).toString("hex")}`;

    const [account] = await db
        .insert(accounts)
        .values({
            name: "Concurrency Test Account",
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
            name: "Concurrency Test User",
            externalId: `concurrency-test-${randomUUID()}`,
            planId: userPlanId,
        })
        .returning({ id: users.id });

    userId = user.id;
});


beforeEach(async () => {
    // Keep each concurrency scenario independent: prior tests must not consume
    // quota or leave idempotency records for later scenarios.
    await db.delete(consumptionRequests).where(eq(consumptionRequests.accountId, accountId));
    await db.delete(monthlyUsage).where(eq(monthlyUsage.accountId, accountId));
});

describe("Concurrent quota enforcement", () => {
    it("replays concurrent requests with the same idempotency key exactly once", async () => {
        const requestId = `same-key-${randomUUID()}`;
        const units = 1;

        const responses = await Promise.all(
            Array.from({ length: 8 }, () =>
                request(app)
                    .post("/api/v1/consumption")
                    .set("X-API-Key", apiKey)
                    .set("Idempotency-Key", requestId)
                    .send({ userId, units }),
            ),
        );

        expect(responses.every((response) => response.status === 200)).toBe(true);
        expect(responses.every((response) => response.body.outcome === "accepted")).toBe(true);
        expect(responses.filter((response) => response.body.replayed !== true)).toHaveLength(1);
        expect(responses.filter((response) => response.body.replayed === true)).toHaveLength(7);

        const snapshots = responses.map(({ body }) => {
            const { replayed: _replayed, ...snapshot } = body;
            return JSON.stringify(snapshot);
        });
        expect(new Set(snapshots).size).toBe(1);

        const [accountUsage] = await db
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

        const [userUsage] = await db
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

        expect(accountUsage?.consumedUnits ?? 0).toBe(units);
        expect(userUsage?.consumedUnits ?? 0).toBe(units);
    });

    it("rejects concurrent reuse of one idempotency key with different payloads", async () => {
        const requestId = `conflicting-key-${randomUUID()}`;
        const responses = await Promise.all([
            request(app)
                .post("/api/v1/consumption")
                .set("X-API-Key", apiKey)
                .set("Idempotency-Key", requestId)
                .send({ userId, units: 1 }),
            request(app)
                .post("/api/v1/consumption")
                .set("X-API-Key", apiKey)
                .set("Idempotency-Key", requestId)
                .send({ userId, units: 2 }),
        ]);

        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
        expect(responses.find((response) => response.status === 409)?.body.error.code)
            .toBe("IDEMPOTENCY_CONFLICT");

        const [accountUsage] = await db
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

        const [userUsage] = await db
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

        const acceptedResponse = responses.find((response) => response.status === 200);
        const expectedUnits = acceptedResponse?.body.units;

        expect(expectedUnits).toBeGreaterThanOrEqual(1);
        expect(expectedUnits).toBeLessThanOrEqual(2);
        expect(accountUsage?.consumedUnits ?? 0).toBe(expectedUnits);
        expect(userUsage?.consumedUnits ?? 0).toBe(expectedUnits);
    });

    it("does not exceed the account monthly quota when requests arrive concurrently", async () => {
        const responses = await Promise.all(
            Array.from({ length: 5 }, () =>
                request(app)
                    .post("/api/v1/consumption")
                    .set("X-API-Key", apiKey)
                    .set("Idempotency-Key", `concurrent-${randomUUID()}`)
                    .send({ userId, units: 2 }),
            ),
        );

        expect(responses.every((response) => response.status === 200)).toBe(true);

        const accepted = responses.filter(
            (response) => response.body.outcome === "accepted",
        );
        const rejected = responses.filter(
            (response) => response.body.outcome === "rejected",
        );

        expect(accepted).toHaveLength(2);
        expect(rejected).toHaveLength(3);

        for (const response of rejected) {
            expect(response.body.rejectionReason).toBe(
                "ACCOUNT_MONTHLY_LIMIT_EXCEEDED",
            );
        }

        const [accountUsage] = await db
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

        const [userUsage] = await db
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

        expect(accountUsage?.consumedUnits ?? 0).toBe(4);
        expect(userUsage?.consumedUnits ?? 0).toBe(4);
        expect(accountUsage?.consumedUnits ?? 0).toBeLessThanOrEqual(5);
    });
});

afterAll(async () => {
    try {
        if (accountId) {
            await db.delete(accounts).where(eq(accounts.id, accountId));
        }

        const planIds = [accountPlanId, userPlanId].filter(Boolean);

        if (planIds.length > 0) {
            await db.delete(plans).where(
                eq(plans.id, planIds[0]),
            );

            if (planIds.length > 1) {
                await db.delete(plans).where(
                    eq(plans.id, planIds[1]),
                );
            }
        }
    } finally {
        await pool.end();
    }
});
