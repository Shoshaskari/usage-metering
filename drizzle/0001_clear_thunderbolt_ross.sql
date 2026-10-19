ALTER TABLE "consumption_requests" DROP CONSTRAINT "consumption_requests_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "monthly_usage" DROP CONSTRAINT "monthly_usage_user_id_users_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_id_id_unique" ON "users" USING btree ("account_id","id");
--> statement-breakpoint
ALTER TABLE "consumption_requests" ADD CONSTRAINT "consumption_requests_account_user_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "monthly_usage" ADD CONSTRAINT "monthly_usage_account_user_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."users"("account_id","id") ON DELETE cascade ON UPDATE no action;
