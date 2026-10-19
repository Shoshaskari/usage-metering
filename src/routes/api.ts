import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { accounts, plans, users } from "../db/schema.js";

export const apiRouter = Router();

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

const createAccountSchema = z.object({
  name: z.string().trim().min(2).max(150),
  plan: z.enum(["Starter", "Pro"]).default("Starter"),
});

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(150),
  externalId: z.string().trim().min(1).max(100).optional(),
  plan: z.enum(["Basic", "Premium"]).default("Basic"),
});

export async function authenticateAccount(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const apiKey = req.header("x-api-key");

    if (!apiKey) {
      res.status(401).json({
        error: { code: "API_KEY_REQUIRED", message: "Provide an X-API-Key header." },
      });
      return;
    }

    const [account] = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.apiKeyHash, hashKey(apiKey)))
      .limit(1);

    if (!account) {
      res.status(401).json({
        error: { code: "INVALID_API_KEY", message: "The API key is invalid." },
      });
      return;
    }

    res.locals.account = account;
    next();
  } catch (error) {
    next(error);
  }
}

// Provisioning endpoint: protected by a separate administrative secret.
apiRouter.post("/accounts", async (req, res, next) => {
  try {
    const configuredAdminKey = process.env.ADMIN_API_KEY;
    const providedAdminKey = req.header("x-admin-key");

    if (!configuredAdminKey) {
      res.status(503).json({
        error: {
          code: "ADMIN_NOT_CONFIGURED",
          message: "Account provisioning is not configured.",
        },
      });
      return;
    }

    if (!providedAdminKey || !secureEqual(providedAdminKey, configuredAdminKey)) {
      res.status(401).json({
        error: { code: "INVALID_ADMIN_KEY", message: "Admin authentication failed." },
      });
      return;
    }

    const parsed = createAccountSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          details: parsed.error.issues,
        },
      });
      return;
    }

    const [plan] = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.name, parsed.data.plan),
          eq(plans.scope, "account"),
          eq(plans.isActive, true),
        ),
      )
      .limit(1);

    if (!plan) {
      res.status(500).json({
        error: { code: "ACCOUNT_PLAN_NOT_FOUND", message: "The selected plan is unavailable." },
      });
      return;
    }

    const apiKey = `um_${randomBytes(32).toString("hex")}`;

    const [account] = await db
      .insert(accounts)
      .values({
        name: parsed.data.name,
        planId: plan.id,
        apiKeyHash: hashKey(apiKey),
        apiKeyPrefix: apiKey.slice(0, 11),
      })
      .returning({
        id: accounts.id,
        name: accounts.name,
        planId: accounts.planId,
        createdAt: accounts.createdAt,
      });

    res.status(201).json({
      account,
      apiKey,
      warning: "Store this API key securely. It cannot be retrieved later.",
    });
  } catch (error) {
    next(error);
  }
});

// All user operations are scoped to the authenticated account.
apiRouter.post("/users", authenticateAccount, async (req, res, next) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          details: parsed.error.issues,
        },
      });
      return;
    }

    const account = res.locals.account as { id: string; name: string };

    const [plan] = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.name, parsed.data.plan),
          eq(plans.scope, "user"),
          eq(plans.isActive, true),
        ),
      )
      .limit(1);

    if (!plan) {
      res.status(500).json({
        error: { code: "USER_PLAN_NOT_FOUND", message: "The selected plan is unavailable." },
      });
      return;
    }

    const [user] = await db
      .insert(users)
      .values({
        accountId: account.id,
        name: parsed.data.name,
        externalId: parsed.data.externalId,
        planId: plan.id,
      })
      .returning({
        id: users.id,
        accountId: users.accountId,
        name: users.name,
        externalId: users.externalId,
        planId: users.planId,
        createdAt: users.createdAt,
      });

    res.status(201).json({ user });
  } catch (error) {
    // PostgreSQL unique-constraint violation (for example, duplicate externalId).
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      res.status(409).json({
        error: {
          code: "DUPLICATE_USER",
          message: "A user with this externalId already exists in this account.",
        },
      });
      return;
    }

    next(error);
  }
});
