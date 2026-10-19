const baseUrl = "http://localhost:3000";
const apiKey = process.env.DEMO_API_KEY;
const userId = "cbfabb68-a366-407b-a9ee-93a1d1dc9328";
const requestCount = 20;

if (!apiKey) {
  console.error("Missing DEMO_API_KEY environment variable.");
  process.exit(1);
}

async function getUsage() {
  const response = await fetch(
    `${baseUrl}/api/v1/usage?userId=${userId}`,
    { headers: { "X-API-Key": apiKey } },
  );

  if (!response.ok) {
    throw new Error(`Usage request failed: HTTP ${response.status}`);
  }

  return response.json();
}

async function main() {
  const before = await getUsage();
  const initialUsed = before.user.used;

  console.log(`Starting user usage: ${initialUsed}`);
  console.log(`Sending ${requestCount} concurrent requests...`);

  const results = await Promise.all(
    Array.from({ length: requestCount }, async (_, index) => {
      const response = await fetch(`${baseUrl}/api/v1/consumption`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "Idempotency-Key": `concurrency-${Date.now()}-${index}`,
        },
        body: JSON.stringify({ userId, units: 1 }),
      });

      const body = await response.json();

      return {
        status: response.status,
        outcome: body.outcome,
        body,
      };
    }),
  );

  const failed = results.filter(
    (result) => result.status !== 200 || result.outcome !== "accepted",
  );

  const after = await getUsage();
  const finalUsed = after.user.used;
  const actualIncrease = finalUsed - initialUsed;

  console.log(`Accepted: ${results.length - failed.length}`);
  console.log(`Failed or rejected: ${failed.length}`);
  console.log(`Expected usage increase: ${requestCount}`);
  console.log(`Actual usage increase: ${actualIncrease}`);

  if (failed.length > 0) {
    console.error("Failed request examples:", failed.slice(0, 3));
  }

  if (failed.length === 0 && actualIncrease === requestCount) {
    console.log("PASS: Concurrent consumption was counted correctly.");
    return;
  }

  console.error("FAIL: Concurrent consumption check did not pass.");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
