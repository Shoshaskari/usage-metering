CREATE TYPE "public"."consumption_outcome" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."plan_scope" AS ENUM('account', 'user');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"api_key_hash" varchar(64) NOT NULL,
	"api_key_prefix" varchar(16) NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "consumption_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" varchar(128) NOT NULL,
	"units" integer NOT NULL,
	"outcome" "consumption_outcome" NOT NULL,
	"rejection_reason" varchar(80),
	"usage_month" date NOT NULL,
	"response_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumption_requests_units_positive" CHECK ("consumption_requests"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "monthly_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid,
	"usage_month" date NOT NULL,
	"consumed_units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_usage_consumed_nonnegative" CHECK ("monthly_usage"."consumed_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"scope" "plan_scope" NOT NULL,
	"monthly_limit" integer NOT NULL,
	"max_units_per_request" integer NOT NULL,
	"owner_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_monthly_limit_positive" CHECK ("plans"."monthly_limit" > 0),
	CONSTRAINT "plans_max_units_positive" CHECK ("plans"."max_units_per_request" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" varchar(100),
	"name" varchar(150) NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption_requests" ADD CONSTRAINT "consumption_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumption_requests" ADD CONSTRAINT "consumption_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_usage" ADD CONSTRAINT "monthly_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_usage" ADD CONSTRAINT "monthly_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_plan_id_idx" ON "accounts" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consumption_requests_account_request_unique" ON "consumption_requests" USING btree ("account_id","request_id");--> statement-breakpoint
CREATE INDEX "consumption_requests_account_created_idx" ON "consumption_requests" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "consumption_requests_user_created_idx" ON "consumption_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_usage_account_month_unique" ON "monthly_usage" USING btree ("account_id","usage_month") WHERE "monthly_usage"."user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_usage_user_month_unique" ON "monthly_usage" USING btree ("user_id","usage_month") WHERE "monthly_usage"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "monthly_usage_account_idx" ON "monthly_usage" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "monthly_usage_user_idx" ON "monthly_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plans_scope_idx" ON "plans" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_external_id_unique" ON "users" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "users_account_id_idx" ON "users" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "users_plan_id_idx" ON "users" USING btree ("plan_id");