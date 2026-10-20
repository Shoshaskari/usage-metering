# Usage Metering & Quota Service

A TypeScript REST API for managing account and user monthly usage quotas. The service records consumption attempts, enforces request and monthly limits, and supports idempotent retries using PostgreSQL transactions.

## Engineering Highlights

- **Tenant isolation:** API keys scope requests to their owning account.
- **Idempotent consumption:** retries with the same key and payload return the stored result, while conflicting payloads are rejected.
- **Concurrency safety:** database transactions and row-level locking protect quota updates from concurrent requests.
- **Auditable failures:** rejected consumption attempts remain in history without consuming quota.
- **Time-consistent quotas:** monthly usage is calculated using UTC calendar months.
- **Input validation:** request payloads are validated, and common client errors return structured API responses.

## Verification

- Automated test suite: **30 tests passing** across 4 test files.
- TypeScript type checking and production build pass.
- GitHub Actions CI runs the checks against PostgreSQL.
- Load-test baseline: approximately **587 requests/second** with 10 connections over 30 seconds, with zero reported errors or timeouts in that run.

*Load-test results are a local baseline, not a production capacity guarantee.*

## Features

- API-key authentication and account-level isolation.
- Admin-protected account provisioning.
- Independent account and user quota plans.
- Per-request and monthly usage limits.
- Idempotency keys to prevent duplicate consumption.
- Persistent history for accepted and rejected requests.
- PostgreSQL transactions for consistent usage updates.
- Usage summaries and paginated history.
- Structured request logging with sensitive API-key headers redacted.
- Docker Compose, database migrations, and seed data.
- Automated API tests, smoke tests, and a concurrency-check script.

## Tech Stack

- Node.js 22
- TypeScript and Express
- PostgreSQL 16
- Drizzle ORM and Drizzle Kit
- Zod
- Vitest and Supertest
- Pino and pino-http
- Docker Compose

## Architecture

```text
Client
  |
  v
Express REST API
  |-- Authentication
  |-- Account and user management
  |-- Plan and quota validation
  |-- Idempotency handling
  |-- Usage and history
  |
  v
PostgreSQL
  |-- accounts
  |-- users
  |-- plans
  |-- monthly_usage
  |-- consumption_requests
```

Usage is tracked independently for the account and the selected user. The service uses UTC calendar months. Accepted requests update both applicable usage records in a database transaction. Rejected requests are saved in history but consume no units.

An idempotency key is scoped to an account. Repeating the same key and payload returns the stored result; reusing the key with a different payload returns a conflict.

## Quick Start: Docker

1. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and replace the example `ADMIN_API_KEY` with a strong private value. Never commit or share `.env`.

3. Build and start the services:

   ```bash
   docker compose up --build -d
   ```

4. Check service status and API health:

   ```bash
   docker compose ps
   curl http://localhost:3001/healthz
   curl http://localhost:3001/readyz
   ```

The API is available at `http://localhost:3001`. PostgreSQL is exposed on host port `5433`. Inside Docker, the API connects to `db:5432`.

The API container applies database migrations and seeds the predefined plans on startup.

View logs:

```bash
docker compose logs -f app
```

Stop containers without deleting database data:

```bash
docker compose down
```

To delete the local database volume as well, use `docker compose down -v`. This permanently deletes its stored data.

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | HTTP server port |
| `DATABASE_URL` | PostgreSQL connection string |
| `NODE_ENV` | Runtime environment |
| `ADMIN_API_KEY` | Secret required for account provisioning |

For local development, the database URL is:

```text
postgresql://app_user:local_dev_password@localhost:5433/usage_metering
```

Docker Compose overrides `DATABASE_URL` inside the API container to use `db:5432`.

## Local Development

Start PostgreSQL:

```bash
docker compose up -d db
```

Configure `.env`, install dependencies, migrate and seed the database, then start the development server:

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

The local API listens on port `3000` by default.

## API Endpoints

All API endpoints below use the `/api/v1` prefix except health checks.

| Method | Endpoint | Authentication | Description |
|---|---|---|---|
| GET | `/healthz` | Public | Health check |
| GET | `/readyz` | Public | Database readiness check |
| POST | `/api/v1/accounts` | `X-Admin-Key` | Create an account and issue an API key |
| POST | `/api/v1/users` | `X-API-Key` | Create a user within the account |
| POST | `/api/v1/consumption` | `X-API-Key`, `Idempotency-Key` | Submit a usage request |
| GET | `/api/v1/usage` | `X-API-Key` | Get current usage |
| GET | `/api/v1/history` | `X-API-Key` | Get paginated consumption history |

Account provisioning returns the generated API key once. Store it securely. Only its hash is stored in the database.

### Example: Get Usage

Read the API key without printing it:

```bash
read -rsp "Account API key: " API_KEY
echo
```

For the Docker API:

```bash
curl -sS \
  -H "X-API-Key: $API_KEY" \
  http://localhost:3001/api/v1/usage
```

### Example: Submit Consumption

Replace `YOUR_USER_ID` with a UUID belonging to the authenticated account. Use a unique idempotency key for each new logical request.

```bash
curl -i -X POST http://localhost:3001/api/v1/consumption \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -H "Idempotency-Key: demo-request-001" \
  -d '{"userId":"YOUR_USER_ID","units":5}'
```

### Example: Query History

```bash
curl -sS \
  -H "X-API-Key: $API_KEY" \
  "http://localhost:3001/api/v1/history?page=1&limit=10"
```

History supports pagination and optional `userId` and `outcome` filters. The outcome filter accepts `accepted` or `rejected`.

Remove the key from your shell when finished:

```bash
unset API_KEY
```

## Default Plans

| Plan | Scope | Monthly limit | Maximum units per request |
|---|---|---:|---:|
| Starter | Account | 1,000 | 50 |
| Pro | Account | 10,000 | 200 |
| Basic | User | 100 | 10 |
| Premium | User | 1,000 | 50 |

Account and user plans are evaluated independently. A request can be rejected if either applicable per-request or monthly quota is exceeded.

## Development Commands

```bash
npm run dev
npm run build
npm run typecheck
npm test
npm run test:watch
npm run db:generate
npm run db:migrate
npm run db:seed
npm run db:studio
```

## Tests

Run the automated tests and static checks:

```bash
npm test
npm run typecheck
npm run build
```

The smoke test requires a running API and a development account key:

```bash
read -rsp "Account API key: " DEMO_API_KEY
echo
export DEMO_API_KEY
./scripts/smoke-test.sh
unset DEMO_API_KEY
```

The concurrency test also requires a running API and account key:

```bash
read -rsp "Account API key: " DEMO_API_KEY
echo
export DEMO_API_KEY
node scripts/concurrency-test.mjs
unset DEMO_API_KEY
```

Run these scripts against a development account only. Accepted concurrency-test requests consume quota.

## Security Notes

- Keep `.env` private and excluded from version control.
- Use strong, unique API and admin keys.
- API keys are hashed before storage.
- Sensitive API-key headers are redacted from request logs.
- The PostgreSQL password shown here is for local development only.
- Before public production deployment, add and review rate limiting, production secret management, backups, monitoring, and deployment-specific security controls.

## Project Scope

This project is a single REST service backed by PostgreSQL. It does not require Redis, Kafka, MongoDB, Kubernetes, or separate microservices.

## Documentation

- [API Guide](docs/API-GUIDE.md)
- [Technical Interview Guide](docs/INTERVIEW-GUIDE.md)
- [Browser Demo](http://localhost:3001/demo/)
