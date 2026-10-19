# Usage Metering API — Technical Interview Guide

## 1. Project Summary

This project is a multi-tenant usage metering API built with
Node.js, TypeScript, Express, PostgreSQL, Drizzle ORM, and Zod.

It supports account and user management, configurable plans,
monthly usage limits, consumption history, and idempotent requests.

The application includes automated tests, structured logging,
database migrations, Docker Compose, and a browser demo.

## 2. Architecture

- Express handles HTTP routing and middleware.
- TypeScript provides static type checking.
- Zod validates incoming request data.
- PostgreSQL stores accounts, users, plans, and consumption records.
- Drizzle ORM handles database queries and transactions.
- Pino provides structured HTTP logging.
- Vitest and Supertest support automated API testing.
- Docker Compose runs the application and database locally.

## 3. Important Design Decisions

### Multi-Tenancy

Each API key identifies an account. Protected operations must use
that account's context when accessing users, plans, and usage records.

This helps prevent one account from accessing another account's data.

### Idempotency

Consumption requests require an Idempotency-Key header.

When the same key and payload are submitted again, the API returns
the previously recorded result instead of applying usage twice.

If the key is reused with a different user or units value, the API
returns an idempotency conflict.

This is useful when a client retries after a network timeout.

### Concurrency

Consumption is processed inside a database transaction. The account
row is locked with SELECT ... FOR UPDATE before quota checks and
updates are performed.

This serializes consumption operations for the same account and
helps prevent concurrent requests from exceeding account limits.

The trade-off is that requests for one account can wait on each
other under heavy load.

### Monthly Usage

Usage is grouped by UTC calendar month. Using UTC avoids relying on
the server's local timezone to determine monthly boundaries.

### Rejected Requests

Rejected consumption attempts are stored in history but do not
increase usage. This supports troubleshooting and auditing.

### API Key Security

API keys are hashed before being stored, and the raw key is returned
only when it is created. Sensitive authentication headers are
redacted from application logs.

## 4. Validation and Error Handling

Incoming request bodies and query parameters are validated before
business logic runs.

Typical responses include:

- 400 Bad Request: invalid input.
- 401 Unauthorized: missing or invalid authentication.
- 404 Not Found: requested resource is unavailable.
- 409 Conflict: duplicate resource or idempotency conflict.
- 413 Payload Too Large: request body exceeds the configured limit.

Clients should inspect the error code rather than relying only on
human-readable error messages.

## 5. Health Checks

GET /healthz checks whether the HTTP service is running.

GET /readyz checks whether the application can reach PostgreSQL.

Separating liveness from readiness helps container orchestration
and deployment systems determine whether the service can accept work.

## 6. Testing Strategy

The project uses automated tests to exercise API behavior.

Important cases to cover include:

- Successful account and user creation.
- Authentication failures.
- Invalid request bodies.
- Duplicate external user IDs.
- Successful consumption.
- Idempotent replay.
- Reuse of an idempotency key with a different payload.
- Account and user quota limits.
- Rejected request history.
- Usage and history filtering.
- Plan creation and plan changes.
- Concurrent consumption.

A passing test suite provides evidence for tested behavior, but
does not by itself prove production readiness.

## 7. Performance and Benchmarking

The project includes a load test for the usage endpoint.

A previous local run with 10 connections over 30 seconds measured
approximately 587 requests per second, with 16.51 ms average latency
and 29 ms p99 latency. It reported no HTTP errors or timeouts.

These are results from one local test environment, not a production
capacity guarantee. Performance depends on hardware, database state,
connection pooling, and workload.

The benchmark reads usage and does not intentionally consume quota.

## 8. Potential Production Improvements

- Add API-key rotation and revocation.
- Add rate limiting and abuse protection.
- Define retention and cleanup policies for idempotency records.
- Add metrics, distributed tracing, and alerting.
- Configure database backups and recovery drills.
- Review database indexes using realistic workloads.
- Tune connection pooling and transaction contention.
- Add a dedicated least-privilege database role.
- Establish deployment, migration, and rollback procedures.
- Add load tests for concurrent consumption, not only read traffic.

## 9. Sample Interview Questions

### Why use idempotency keys?

Clients can retry requests after network failures without accidentally
recording the same logical consumption operation more than once.

### Why use a database transaction?

Quota checks and usage updates must be coordinated. A transaction
keeps related operations consistent and allows rollback on failure.

### Why lock the account row?

The lock serializes quota-sensitive operations for one account,
reducing the risk of concurrent requests overspending the quota.

### Why store rejected requests?

Rejected attempts help explain why operations failed and provide
useful audit history without increasing consumed usage.

### Why use UTC for monthly limits?

UTC gives the application a consistent definition of month boundaries
regardless of the host machine's timezone.

### What is the difference between liveness and readiness?

Liveness indicates that the process is running. Readiness indicates
that the service's required dependencies, such as PostgreSQL, are
available for handling requests.

### What would you improve first for production?

I would prioritize API-key rotation, rate limiting, observability,
database backup and recovery procedures, and load testing of
concurrent consumption.

## 10. Short Project Pitch

I built a multi-tenant usage metering API with account and user
quotas, configurable plans, idempotent consumption, and paginated
history. I focused on data consistency through database transactions,
tenant isolation, input validation, and automated testing. I also
added Docker-based local development, structured logging, and a
load-testing script to measure endpoint performance.
