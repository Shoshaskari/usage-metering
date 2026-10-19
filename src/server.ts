import "dotenv/config";
import { app } from "./app.js";
import { pool } from "./db/index.js";

const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`Usage Metering API running on port ${port}`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} received. Shutting down gracefully...`);

  server.close(async (error) => {
    try {
      await pool.end();

      if (error) {
        console.error("HTTP server shutdown failed:", error);
        process.exitCode = 1;
      } else {
        console.log("Shutdown complete.");
      }
    } catch (shutdownError) {
      console.error("Database shutdown failed:", shutdownError);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
