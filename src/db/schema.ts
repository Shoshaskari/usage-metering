import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  check,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const planScopeEnum = pgEnum("plan_scope", [
  "account",
  "user",
]);

export const consumptionOutcomeEnum = pgEnum("consumption_outcome", [
  "accepted",
  "rejected",
]);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    scope: planScopeEnum("scope").notNull(),
    monthlyLimit: integer("monthly_limit").notNull(),
    maxUnitsPerRequest: integer("max_units_per_request").notNull(),
    ownerAccountId: uuid("owner_account_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "plans_monthly_limit_positive",
      sql`${table.monthlyLimit} > 0`,
    ),
    check(
      "plans_max_units_positive",
      sql`${table.maxUnitsPerRequest} > 0`,
    ),
    index("plans_scope_idx").on(table.scope),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 150 }).notNull(),
    apiKeyHash: varchar("api_key_hash", { length: 64 })
      .notNull()
      .unique(),
    apiKeyPrefix: varchar("api_key_prefix", { length: 16 }).notNull(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("accounts_plan_id_idx").on(table.planId),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    externalId: varchar("external_id", { length: 100 }),
    name: varchar("name", { length: 150 }).notNull(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_account_external_id_unique").on(
      table.accountId,
      table.externalId,
    ),
    index("users_account_id_idx").on(table.accountId),
    index("users_plan_id_idx").on(table.planId),
  ],
);

export const monthlyUsage = pgTable(
  "monthly_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    usageMonth: date("usage_month").notNull(),
    consumedUnits: integer("consumed_units").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "monthly_usage_consumed_nonnegative",
      sql`${table.consumedUnits} >= 0`,
    ),
    uniqueIndex("monthly_usage_account_month_unique")
      .on(table.accountId, table.usageMonth)
      .where(sql`${table.userId} IS NULL`),
    uniqueIndex("monthly_usage_user_month_unique")
      .on(table.userId, table.usageMonth)
      .where(sql`${table.userId} IS NOT NULL`),
    index("monthly_usage_account_idx").on(table.accountId),
    index("monthly_usage_user_idx").on(table.userId),
  ],
);

export const consumptionRequests = pgTable(
  "consumption_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: varchar("request_id", { length: 128 }).notNull(),
    units: integer("units").notNull(),
    outcome: consumptionOutcomeEnum("outcome").notNull(),
    rejectionReason: varchar("rejection_reason", { length: 80 }),
    usageMonth: date("usage_month").notNull(),
    responseSnapshot: jsonb("response_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "consumption_requests_units_positive",
      sql`${table.units} > 0`,
    ),
    uniqueIndex("consumption_requests_account_request_unique").on(
      table.accountId,
      table.requestId,
    ),
    index("consumption_requests_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    index("consumption_requests_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);
