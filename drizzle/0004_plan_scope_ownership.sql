-- Prevent custom plans from outliving their owning account.
ALTER TABLE "plans"
ADD CONSTRAINT "plans_owner_account_id_accounts_id_fk"
FOREIGN KEY ("owner_account_id")
REFERENCES "accounts"("id")
ON DELETE RESTRICT;
--> statement-breakpoint

-- Validate account plan scope and ownership on insert/update.
CREATE OR REPLACE FUNCTION validate_account_plan_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_scope "plan_scope";
  plan_owner uuid;
BEGIN
  SELECT scope, owner_account_id
    INTO plan_scope, plan_owner
  FROM plans
  WHERE id = NEW.plan_id
  FOR SHARE;

  IF plan_scope IS DISTINCT FROM 'account'::"plan_scope" THEN
    RAISE EXCEPTION 'Account must use an account-scope plan'
      USING ERRCODE = '23514';
  END IF;

  IF plan_owner IS NOT NULL AND plan_owner <> NEW.id THEN
    RAISE EXCEPTION 'Account cannot use another account''s custom plan'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER accounts_validate_plan_assignment
BEFORE INSERT OR UPDATE ON accounts
FOR EACH ROW
EXECUTE FUNCTION validate_account_plan_assignment();
--> statement-breakpoint

-- Validate user plan scope and ownership on insert/update.
CREATE OR REPLACE FUNCTION validate_user_plan_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_scope "plan_scope";
  plan_owner uuid;
BEGIN
  SELECT scope, owner_account_id
    INTO plan_scope, plan_owner
  FROM plans
  WHERE id = NEW.plan_id
  FOR SHARE;

  IF plan_scope IS DISTINCT FROM 'user'::"plan_scope" THEN
    RAISE EXCEPTION 'User must use a user-scope plan'
      USING ERRCODE = '23514';
  END IF;

  IF plan_owner IS NOT NULL AND plan_owner <> NEW.account_id THEN
    RAISE EXCEPTION 'User cannot use another account''s custom plan'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER users_validate_plan_assignment
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION validate_user_plan_assignment();
--> statement-breakpoint

-- Do not let plan edits invalidate existing assignments.
CREATE OR REPLACE FUNCTION validate_plan_assignment_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM accounts a
    WHERE a.plan_id = NEW.id
      AND (
        NEW.scope <> 'account'::"plan_scope"
        OR (NEW.owner_account_id IS NOT NULL AND NEW.owner_account_id <> a.id)
      )
  ) THEN
    RAISE EXCEPTION 'Plan change would invalidate an account assignment'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM users u
    WHERE u.plan_id = NEW.id
      AND (
        NEW.scope <> 'user'::"plan_scope"
        OR (NEW.owner_account_id IS NOT NULL AND NEW.owner_account_id <> u.account_id)
      )
  ) THEN
    RAISE EXCEPTION 'Plan change would invalidate a user assignment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER plans_validate_assignment_changes
BEFORE UPDATE OF scope, owner_account_id ON plans
FOR EACH ROW
EXECUTE FUNCTION validate_plan_assignment_changes();
