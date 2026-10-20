import { Router, type Response, type NextFunction, type Request } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
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

export const consumptionRouter = Router();

const consumptionSchema = z.object({
  userId: z.string().uuid(),
  units: z.number().int().positive().max(1_000_000),
});

type AccountContext = { id: string; name: string };

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
) {
  res.status(status).json({ error: { code, message } });
}

consumptionRouter.post(
  "/",
  authenticateAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const account = res.locals.account as AccountContext;
      const requestId = req.header("Idempotency-Key");

      if (!requestId || requestId.trim().length === 0 || requestId.length > 128) {
        sendError(
          res,
          400,
          "INVALID_IDEMPOTENCY_KEY",
          "Provide an Idempotency-Key header containing 1–128 characters.",
        );
        return;
      }

      const parsed = consumptionSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            details: parsed.error.issues,
          },
        });
        return;
      }

      const { userId, units } = parsed.data;
      const now = new Date();
      const usageMonth = `${now.getUTCFullYear()}-${String(
        now.getUTCMonth() + 1,
      ).padStart(2, "0")}-01`;

      const result = await db.transaction(async (tx) => {
        // Serialize consumption requests within this account.
        // This prevents concurrent requests from exceeding either quota.
        await tx.execute(
          sql`SELECT id FROM accounts WHERE id = ${account.id} FOR UPDATE`,
        );

        const [existing] = await tx
          .select()
          .from(consumptionRequests)
          .where(
            and(
              eq(consumptionRequests.accountId, account.id),
              eq(consumptionRequests.requestId, requestId),
            ),
          )
          .limit(1);

        if (existing) {
          if (existing.userId !== userId || existing.units !== units) {
            return {
              status: 409,
              body: {
                error: {
                  code: "IDEMPOTENCY_CONFLICT",
                  message:
                    "This Idempotency-Key was already used with a different payload.",
                },
              },
            };
          }

          return {
            status: 200,
            body: {
              ...(existing.responseSnapshot as Record<string, unknown>),
              replayed: true,
            },
          };
        }

        const [accountPlan] = await tx
          .select({
            accountId: accounts.id,
            planName: plans.name,
            monthlyLimit: plans.monthlyLimit,
            maxUnitsPerRequest: plans.maxUnitsPerRequest,
          })
          .from(accounts)
          .innerJoin(plans, eq(accounts.planId, plans.id))
          .where(eq(accounts.id, account.id))
          .limit(1);

        if (!accountPlan) {
          return {
            status: 401,
            body: {
              error: {
                code: "ACCOUNT_NOT_FOUND",
                message: "The authenticated account no longer exists.",
              },
            },
          };
        }

        const [userPlan] = await tx
          .select({
            id: users.id,
            name: users.name,
            planName: plans.name,
            monthlyLimit: plans.monthlyLimit,
            maxUnitsPerRequest: plans.maxUnitsPerRequest,
          })
          .from(users)
          .innerJoin(plans, eq(users.planId, plans.id))
          .where(
            and(eq(users.id, userId), eq(users.accountId, account.id)),
          )
          .limit(1);

        if (!userPlan) {
          return {
            status: 404,
            body: {
              error: {
                code: "USER_NOT_FOUND",
                message: "The user does not belong to this account.",
              },
            },
          };
        }

        const [accountUsage] = await tx
          .select()
          .from(monthlyUsage)
          .where(
            and(
              eq(monthlyUsage.accountId, account.id),
              isNull(monthlyUsage.userId),
              eq(monthlyUsage.usageMonth, usageMonth),
            ),
          )
          .limit(1);

        const [userUsage] = await tx
          .select()
          .from(monthlyUsage)
          .where(
            and(
              eq(monthlyUsage.accountId, account.id),
              eq(monthlyUsage.userId, userId),
              eq(monthlyUsage.usageMonth, usageMonth),
            ),
          )
          .limit(1);

        const accountConsumed = accountUsage?.consumedUnits ?? 0;
        const userConsumed = userUsage?.consumedUnits ?? 0;

        // Keep rejection priority stable and predictable.
        let rejectionReason: string | null = null;

        if (units > accountPlan.maxUnitsPerRequest) {
          rejectionReason = "ACCOUNT_REQUEST_LIMIT_EXCEEDED";
        } else if (units > userPlan.maxUnitsPerRequest) {
          rejectionReason = "USER_REQUEST_LIMIT_EXCEEDED";
        } else if (
          accountConsumed + units > accountPlan.monthlyLimit
        ) {
          rejectionReason = "ACCOUNT_MONTHLY_LIMIT_EXCEEDED";
        } else if (userConsumed + units > userPlan.monthlyLimit) {
          rejectionReason = "USER_MONTHLY_LIMIT_EXCEEDED";
        }

        const accepted = rejectionReason === null;
        const outcome = accepted ? "accepted" : "rejected";

        const snapshot = {
          requestId,
          outcome,
          units,
          rejectionReason,
          usageMonth,
          account: {
            id: account.id,
            plan: accountPlan.planName,
            used: accountConsumed + (accepted ? units : 0),
            limit: accountPlan.monthlyLimit,
            remaining: Math.max(
              0,
              accountPlan.monthlyLimit -
                accountConsumed -
                (accepted ? units : 0),
            ),
          },
          user: {
            id: userPlan.id,
            plan: userPlan.planName,
            used: userConsumed + (accepted ? units : 0),
            limit: userPlan.monthlyLimit,
            remaining: Math.max(
              0,
              userPlan.monthlyLimit -
                userConsumed -
                (accepted ? units : 0),
            ),
          },
        };

        // Only accepted requests update monthly usage.
        if (accepted) {
          if (accountUsage) {
            await tx
              .update(monthlyUsage)
              .set({
                consumedUnits: accountConsumed + units,
                updatedAt: now,
              })
              .where(eq(monthlyUsage.id, accountUsage.id));
          } else {
            await tx.insert(monthlyUsage).values({
              accountId: account.id,
              userId: null,
              usageMonth,
              consumedUnits: units,
              updatedAt: now,
            });
          }

          if (userUsage) {
            await tx
              .update(monthlyUsage)
              .set({
                consumedUnits: userConsumed + units,
                updatedAt: now,
              })
              .where(eq(monthlyUsage.id, userUsage.id));
          } else {
            await tx.insert(monthlyUsage).values({
              accountId: account.id,
              userId,
              usageMonth,
              consumedUnits: units,
              updatedAt: now,
            });
          }
        }

        // Persist accepted AND rejected decisions for audit and idempotency.
        await tx.insert(consumptionRequests).values({
          accountId: account.id,
          userId,
          requestId,
          units,
          outcome,
          rejectionReason,
          usageMonth,
          responseSnapshot: snapshot,
        });

        return { status: 200, body: snapshot };
      });

      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  },
);
