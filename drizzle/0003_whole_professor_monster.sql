DROP INDEX "plans_name_scope_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "plans_default_name_scope_unique" ON "plans" USING btree ("name","scope") WHERE "plans"."owner_account_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_owner_name_scope_unique" ON "plans" USING btree ("name","scope","owner_account_id") WHERE "plans"."owner_account_id" IS NOT NULL;