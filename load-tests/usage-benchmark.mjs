import autocannon from "autocannon";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = (process.env.BASE_URL || "http://localhost:3001")
  .replace(/\/+$/, "");
const apiKey = process.env.DEMO_API_KEY;

if (!apiKey) {
  console.error("Missing DEMO_API_KEY. Set it without printing the value.");
  process.exit(1);
}

const duration = Number.parseInt(process.env.DURATION || "15", 10);
const connections = Number.parseInt(process.env.CONNECTIONS || "5", 10);

if (!Number.isInteger(duration) || duration < 1 || duration > 120) {
  throw new Error("DURATION must be an integer between 1 and 120 seconds.");
}

if (!Number.isInteger(connections) || connections < 1 || connections > 25) {
  throw new Error("CONNECTIONS must be an integer between 1 and 25.");
}

const url = `${baseUrl}/api/v1/usage`;

console.log(`Benchmarking ${url}`);
console.log(`Duration: ${duration}s; connections: ${connections}`);
console.log("Endpoint is read-only; no consumption units should be added.");

const result = await new Promise((resolve, reject) => {
  autocannon(
    {
      url,
      method: "GET",
      duration,
      connections,
      headers: {
        "X-API-Key": apiKey,
        accept: "application/json",
      },
      timeout: 10,
    },
    (error, stats) => {
      if (error) reject(error);
      else resolve(stats);
    },
  );
});

const report = {
  timestamp: new Date().toISOString(),
  target: url,
  method: "GET",
  durationSeconds: duration,
  connections,
  requests: result.requests,
  latencyMs: result.latency,
  throughputBytesPerSecond: result.throughput,
  statusCodes: result.statusCodeStats,
  errors: result.errors,
  timeouts: result.timeouts,
  non2xx: result.non2xx,
};

await mkdir("load-tests/results", { recursive: true });
const filename = `load-tests/results/usage-${Date.now()}.json`;
await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`);

console.log("\n=== Benchmark summary ===");
console.log(`Requests/sec average: ${result.requests.average}`);
console.log(`Latency average:      ${result.latency.average} ms`);
console.log(`Latency p97.5:        ${result.latency.p97_5} ms`);
console.log(`Latency p99:          ${result.latency.p99} ms`);
console.log(`Non-2xx responses:    ${result.non2xx}`);
console.log(`Errors:               ${result.errors}`);
console.log(`Timeouts:             ${result.timeouts}`);
console.log(`Report saved to:      ${filename}`);

if (result.non2xx > 0 || result.errors > 0 || result.timeouts > 0) {
  console.error(
    "WARNING: Some requests failed. Inspect status codes and the saved report.",
  );
  process.exitCode = 1;
}
