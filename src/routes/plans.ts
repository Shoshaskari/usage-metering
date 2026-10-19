import { Router } from "express";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { accounts, plans, users } from "../db/schema.js";
import { authenticateAccount } from "./api.js";

export const plansRouter = Router();

const createPlanSchema = z.object({
  name: z.string().trim().min(2).max(100),
  scope: z.enum(["account", "user"]),
  monthlyLimit: z.number().int().min(1).max(2_147_483_647),
  maxUnitsPerRequest: z.number().int().min(1).max(2_147_483_647),
});

const updatePlanSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  monthlyLimit: z.number().int().min(1).max(2_147_483_647).optional(),
  maxUnitsPerRequest: z.number().int().min(1).max(2_147_483_647).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "Provide at least one field to update.",
});

const assignPlanSchema = z.object({
  planId: z.string().uuid(),
});

function sendValidationError(res: import("express").Response, issues: unknown) {
  res.status(400).json({
    error: { code: "VALIDATION_ERROR", details: issues },
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("code" in error && error.code === "23505") {
    return true;
  }

  if ("cause" in error) {
    return isUniqueViolation(error.cause);
  }

  return false;
}

function sendDuplicatePlan(res: import("express").Response) {
  res.status(409).json({
    error: {
      code: "DUPLICATE_PLAN",
      message: "A plan with this name and scope already exists in this account.",
    },
  });
}

// List predefined plans and plans owned by the authenticated account.
plansRouter.get("/plans", authenticateAccount, async (_req, res, next) => {
  try {
    const account = res.locals.account as { id: string; name: string };

    const result = await db
      .select({
        id: plans.id,
        name: plans.name,
        scope: plans.scope,
        monthlyLimit: plans.monthlyLimit,
        maxUnitsPerRequest: plans.maxUnitsPerRequest,
        ownerAccountId: plans.ownerAccountId,
        isActive: plans.isActive,
        createdAt: plans.createdAt,
        updatedAt: plans.updatedAt,
      })
      .from(plans)
      .where(
        or(
          isNull(plans.ownerAccountId),
          eq(plans.ownerAccountId, account.id),
        ),
      )
      .orderBy(plans.scope, plans.name);

    res.status(200).json({ plans: result });
  } catch (error) {
    next(error);
  }
});

// Create a custom plan owned by the authenticated account.
plansRouter.post("/plans", authenticateAccount, async (req, res, next) => {
  try {
    const parsed = createPlanSchema.safeParse(req.body);

    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }

    const account = res.locals.account as { id: string; name: string };

    const [plan] = await db
      .insert(plans)
      .values({
        ...parsed.data,
        ownerAccountId: account.id,
      })
      .returning();

    res.status(201).json({ plan });
  } catch (error) {
    if (isUniqueViolation(error)) {
      sendDuplicatePlan(res);
      return;
    }
    next(error);
  }
});

// Only custom plans owned by this account can be changed.
plansRouter.patch("/plans/:planId", authenticateAccount, async (req, res, next) => {
  try {
    const idParsed = z.string().uuid().safeParse(req.params.planId);
    const parsed = updatePlanSchema.safeParse(req.body);

    if (!idParsed.success) {
      sendValidationError(res, idParsed.error.issues);
      return;
    }
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }

    const account = res.locals.account as { id: string; name: string };

    const [plan] = await db
      .update(plans)
      .set({
        ...parsed.data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(plans.id, idParsed.data),
          eq(plans.ownerAccountId, account.id),
        ),
      )
      .returning();

    if (!plan) {
      res.status(404).json({
        error: {
          code: "CUSTOM_PLAN_NOT_FOUND",
          message: "The custom plan was not found in this account.",
        },
      });
      return;
    }

    res.status(200).json({ plan });
  } catch (error) {
    if (isUniqueViolation(error)) {
      sendDuplicatePlan(res);
      return;
    }
    next(error);
  }
});

// Assign an active account-scope plan to this account.
plansRouter.patch("/accounts/plan", authenticateAccount, async (req, res, next) => {
  try {
    const parsed = assignPlanSchema.safeParse(req.body);

    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }

    const account = res.locals.account as { id: string; name: string };

    const [plan] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.id, parsed.data.planId),
          eq(plans.scope, "account"),
          eq(plans.isActive, true),
          or(
            isNull(plans.ownerAccountId),
            eq(plans.ownerAccountId, account.id),
          ),
        ),
      )
      .limit(1);

    if (!plan) {
      res.status(404).json({
        error: {
          code: "PLAN_NOT_AVAILABLE",
          message: "The account plan was not found or is not available to this account.",
        },
      });
      return;
    }

    const [updated] = await db
      .update(accounts)
      .set({ planId: plan.id, updatedAt: new Date() })
      .where(eq(accounts.id, account.id))
      .returning({
        id: accounts.id,
        name: accounts.name,
        planId: accounts.planId,
        updatedAt: accounts.updatedAt,
      });

    res.status(200).json({ account: updated });
  } catch (error) {
    next(error);
  }
});

// Assign an active user-scope plan to a user belonging to this account.
plansRouter.patch("/users/:userId/plan", authenticateAccount, async (req, res, next) => {
  try {
    const userIdParsed = z.string().uuid().safeParse(req.params.userId);
    const parsed = assignPlanSchema.safeParse(req.body);

    if (!userIdParsed.success) {
      sendValidationError(res, userIdParsed.error.issues);
      return;
    }
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }

    const account = res.locals.account as { id: string; name: string };

    const [plan] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.id, parsed.data.planId),
          eq(plans.scope, "user"),
          eq(plans.isActive, true),
          or(
            isNull(plans.ownerAccountId),
            eq(plans.ownerAccountId, account.id),
          ),
        ),
      )
      .limit(1);

    if (!plan) {
      res.status(404).json({
        error: {
          code: "PLAN_NOT_AVAILABLE",
          message: "The user plan was not found or is not available to this account.",
        },
      });
      return;
    }

    const [updated] = await db
      .update(users)
      .set({ planId: plan.id, updatedAt: new Date() })
      .where(
        and(
          eq(users.id, userIdParsed.data),
          eq(users.accountId, account.id),
        ),
      )
      .returning({
        id: users.id,
        accountId: users.accountId,
        name: users.name,
        planId: users.planId,
        updatedAt: users.updatedAt,
      });

    if (!updated) {
      res.status(404).json({
        error: {
          code: "USER_NOT_FOUND",
          message: "The user was not found in this account.",
        },
      });
      return;
    }

    res.status(200).json({ user: updated });
  } catch (error) {
    next(error);
  }
});
