# Usage Metering API Guide

## Overview

A multi-tenant usage metering API built with Node.js, TypeScript,
Express, PostgreSQL, Drizzle ORM, and Zod.

Local base URL: `http://localhost:3001`

## Authentication

Use the `X-API-Key` header for account-scoped API requests.

Account creation requires the `X-Admin-Key` header.

Do not commit API keys or share them in logs or screenshots.

## Health Checks

- `GET /healthz` — checks whether the API process is running.
- `GET /readyz` — checks whether the database is reachable.

## Create an Account

`POST /api/v1/accounts`

Headers:
- `X-Admin-Key: YOUR_ADMIN_KEY`
- `Content-Type: application/json`

Example body:

    {
      "name": "Demo Account",
      "plan": "Starter"
    }

A successful response includes the account details and a newly
generated API key. Save that key securely; it is only returned once.

## Create a User

`POST /api/v1/users`

Header: `X-API-Key: YOUR_TEST_API_KEY`

Example body:

    {
      "name": "Demo User",
      "externalId": "customer-001",
      "plan": "Basic"
    }

A successful request returns `201 Created` with a `user` object.
An existing external ID within the same account returns
`409 DUPLICATE_USER`.

## Record Consumption

`POST /api/v1/consumption`

Headers:
- `X-API-Key: YOUR_TEST_API_KEY`
- `Idempotency-Key: a-unique-request-key`
- `Content-Type: application/json`

Example body:

    {
      "userId": "YOUR_USER_UUID",
      "units": 5
    }

The units value must be a positive integer no greater than 1,000,000.
The effective plan limits determine whether the request is accepted.

Use a unique idempotency key for each logical operation. Retrying the
same key with the same payload replays the saved result. Reusing the
key with a different user or units returns `409 IDEMPOTENCY_CONFLICT`.

Rejected requests are recorded in history but do not increase usage.

## Read Usage

`GET /api/v1/usage`

Optional query parameter: `userId`.

Example:

    GET /api/v1/usage?userId=YOUR_USER_UUID

The response includes the current UTC usage month, account usage,
limits, remaining units, and—when requested—user-level usage.

## Read Consumption History

`GET /api/v1/history`

Supported query parameters:
- `userId` — filter by user UUID.
- `page` — page number, default `1`.
- `limit` — items per page, default `20`, maximum `100`.
- `outcome` — `accepted` or `rejected`.

The response contains pagination metadata and history items ordered
from newest to oldest.

## Plans

- `GET /api/v1/plans` — list predefined and account-owned plans.
- `POST /api/v1/plans` — create a custom plan.
- `PATCH /api/v1/plans/:planId` — update an account-owned custom plan.
- `PATCH /api/v1/accounts/plan` — change the account plan.
- `PATCH /api/v1/users/:userId/plan` — change a user's plan.

Custom plan creation body:

    {
      "name": "Team",
      "scope": "account",
      "monthlyLimit": 5000,
      "maxUnitsPerRequest": 100
    }

The `scope` must be `account` or `user`. Limits must be positive
integers. Plan changes require an active plan available to the account.

## Quota Behavior

Usage is calculated by UTC calendar month. Both account-level and
user-level monthly limits apply, along with maximum units per request.

Consumption checks apply the account request limit, user request
limit, account monthly limit, and user monthly limit. Rejected requests
do not consume quota.

## Common Errors

- `400` — invalid input or malformed request.
- `401` — missing or invalid authentication, or unavailable account.
- `404` — requested user or plan not found or not available.
- `409` — duplicate user/plan or idempotency conflict.
- `413` — request body too large.

Validation errors include an error code and details where applicable.

## Browser Demo

Start the local application and open:

`http://localhost:3001/demo/`

Use a test API key and a valid user UUID. Avoid using production
credentials in the demo.
