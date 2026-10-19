import { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  accounts,
  plans,
  users,
  monthlyUsage,
  consumptionRequests,
} from "../db/schema.js";
import { authenticateAccount } from "./api.js";

export const usageRouter = Router();

const usageQuerySchema = z.object({
  userId: z.string().uuid().optional(),
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.string().uuid().optional(),
  outcome: z.enum(["accepted", "rejected"]).optional(),
});

function currentUsageMonth(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}-01`;
}

usageRouter.get("/usage", authenticateAccount, async (req, res, next) => {
  try {
    const parsed = usageQuerySchema.safeParse(req.query);

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
    const usageMonth = currentUsageMonth();

    const [accountPlan] = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        plan: plans.name,
        monthlyLimit: plans.monthlyLimit,
        maxUnitsPerRequest: plans.maxUnitsPerRequest,
      })
      .from(accounts)
      .innerJoin(plans, eq(accounts.planId, plans.id))
      .where(eq(accounts.id, account.id))
      .limit(1);

    if (!accountPlan) {
      res.status(404).json({
        error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found." },
      });
      return;
    }

    const [accountUsageRow] = await db
      .select({ consumedUnits: monthlyUsage.consumedUnits })
      .from(monthlyUsage)
      .where(
        and(
          eq(monthlyUsage.accountId, account.id),
          eq(monthlyUsage.usageMonth, usageMonth),
          isNull(monthlyUsage.userId),
        ),
      )
      .limit(1);

    const accountUsed = accountUsageRow?.consumedUnits ?? 0;

    const response: {
      usageMonth: string;
      account: {
        id: string;
        name: string;
        plan: string;
        used: number;
        limit: number;
        remaining: number;
        maxUnitsPerRequest: number;
      };
      user?: {
        id: string;
        name: string;
        plan: string;
        used: number;
        limit: number;
        remaining: number;
        maxUnitsPerRequest: number;
      };
    } = {
      usageMonth,
      account: {
        id: accountPlan.id,
        name: accountPlan.name,
        plan: accountPlan.plan,
        used: accountUsed,
        limit: accountPlan.monthlyLimit,
        remaining: Math.max(0, accountPlan.monthlyLimit - accountUsed),
        maxUnitsPerRequest: accountPlan.maxUnitsPerRequest,
      },
    };

    if (parsed.data.userId) {
      const [userPlan] = await db
        .select({
          id: users.id,
          name: users.name,
          plan: plans.name,
          monthlyLimit: plans.monthlyLimit,
          maxUnitsPerRequest: plans.maxUnitsPerRequest,
        })
        .from(users)
        .innerJoin(plans, eq(users.planId, plans.id))
        .where(
          and(
            eq(users.id, parsed.data.userId),
            eq(users.accountId, account.id),
          ),
        )
        .limit(1);

      if (!userPlan) {
        res.status(404).json({
          error: {
            code: "USER_NOT_FOUND",
            message: "User not found in this account.",
          },
        });
        return;
      }

      const [userUsageRow] = await db
        .select({ consumedUnits: monthlyUsage.consumedUnits })
        .from(monthlyUsage)
        .where(
          and(
            eq(monthlyUsage.accountId, account.id),
            eq(monthlyUsage.userId, userPlan.id),
            eq(monthlyUsage.usageMonth, usageMonth),
          ),
        )
        .limit(1);

      const userUsed = userUsageRow?.consumedUnits ?? 0;

      response.user = {
        id: userPlan.id,
        name: userPlan.name,
        plan: userPlan.plan,
        used: userUsed,
        limit: userPlan.monthlyLimit,
        remaining: Math.max(0, userPlan.monthlyLimit - userUsed),
        maxUnitsPerRequest: userPlan.maxUnitsPerRequest,
      };
    }

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
});

usageRouter.get("/history", authenticateAccount, async (req, res, next) => {
  try {
    const parsed = historyQuerySchema.safeParse(req.query);

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
    const { page, limit, userId, outcome } = parsed.data;

    const filters = [eq(consumptionRequests.accountId, account.id)];

    if (userId) {
      filters.push(eq(consumptionRequests.userId, userId));
    }

    if (outcome) {
      filters.push(eq(consumptionRequests.outcome, outcome));
    }

    const whereClause = and(...filters);

    const [countResult] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(consumptionRequests)
      .where(whereClause);

    const total = countResult?.total ?? 0;

    const items = await db
      .select({
        id: consumptionRequests.id,
        requestId: consumptionRequests.requestId,
        userId: consumptionRequests.userId,
        units: consumptionRequests.units,
        outcome: consumptionRequests.outcome,
        rejectionReason: consumptionRequests.rejectionReason,
        usageMonth: consumptionRequests.usageMonth,
        createdAt: consumptionRequests.createdAt,
      })
      .from(consumptionRequests)
      .where(whereClause)
      .orderBy(desc(consumptionRequests.createdAt), desc(consumptionRequests.id))
      .limit(limit)
      .offset((page - 1) * limit);

    res.status(200).json({
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      items,
    });
  } catch (error) {
    next(error);
  }
});
