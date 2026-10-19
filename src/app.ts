import { apiRouter } from "./routes/api.js";
import { consumptionRouter } from "./routes/consumption.js";
import { usageRouter } from "./routes/usage.js";
import express from "express";
import { pinoHttp } from "pino-http";
import { sql } from "drizzle-orm";
import { db } from "./db/index.js";

export const app = express();

app.disable("x-powered-by");

app.use(express.json({ limit: "100kb" }));
app.use(
  pinoHttp({
    redact: {
      paths: [
        "req.headers['x-api-key']",
        "req.headers['x-admin-key']",
      ],
      censor: "[REDACTED]",
    },
  }),
);
app.use("/api/v1", apiRouter);
app.use("/api/v1", usageRouter);
app.use("/api/v1/consumption", consumptionRouter);

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "usage-metering",
  });
});

app.get("/readyz", async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);

    res.status(200).json({
      status: "ready",
      database: "connected",
    });
  } catch {
    res.status(503).json({
      status: "not_ready",
      database: "unavailable",
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "The requested endpoint does not exist.",
    },
  });
});

app.use(
  (
    error: Error & { status?: number },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Unhandled request error:", error.message);

    const status =
      typeof error.status === "number" &&
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
        ? error.status
        : 500;

    res.status(status).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  },
);
