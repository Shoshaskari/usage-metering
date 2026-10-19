#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
USER_ID="${DEMO_USER_ID:-cbfabb68-a366-407b-a9ee-93a1d1dc9328}"

if [[ -z "${DEMO_API_KEY:-}" ]]; then
  read -rsp "Account API key: " DEMO_API_KEY
  echo
fi

if [[ -z "$DEMO_API_KEY" ]]; then
  echo "FAIL: API key is required"
  exit 1
fi

PASS=0

request() {
  local key="$1"
  local units="$2"

  curl -sS -w '\n%{http_code}' \
    -X POST "$BASE_URL/api/v1/consumption" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $DEMO_API_KEY" \
    -H "Idempotency-Key: $key" \
    -d "{\"userId\":\"$USER_ID\",\"units\":$units}"
}

assert_json() {
  local name="$1"
  local expected_status="$2"
  local expected_field="$3"
  local expected_value="$4"
  local result="$5"

  local status="${result##*$'\n'}"
  local body="${result%$'\n'*}"

  if [[ "$status" != "$expected_status" ]]; then
    echo "FAIL: $name (expected HTTP $expected_status, got $status)"
    echo "$body"
    exit 1
  fi

  if ! BODY="$body" FIELD="$expected_field" EXPECTED="$expected_value" \
    node -e '
      const data = JSON.parse(process.env.BODY);
      const actual = process.env.FIELD.split(".").reduce(
        (value, key) => value?.[key], data
      );
      if (String(actual) !== process.env.EXPECTED) process.exit(1);
    '; then
    echo "FAIL: $name (unexpected response)"
    echo "$body"
    exit 1
  fi

  PASS=$((PASS + 1))
  echo "PASS: $name"
}

RUN_ID="$(date +%s)-$$"
KEY="smoke-$RUN_ID"

echo
echo "Running API smoke tests..."

RESULT="$(request "$KEY-accepted" 5)"
assert_json "Accept a valid consumption request" 200 "outcome" "accepted" "$RESULT"

RESULT="$(request "$KEY-accepted" 5)"
assert_json "Replay the same request without double-counting" 200 "replayed" "true" "$RESULT"

RESULT="$(request "$KEY-accepted" 6)"
assert_json "Reject reuse of an idempotency key with a different payload" 409 "error.code" "IDEMPOTENCY_CONFLICT" "$RESULT"

RESULT="$(request "$KEY-overlimit" 11)"
assert_json "Reject consumption above the user's per-request limit" 200 "rejectionReason" "USER_REQUEST_LIMIT_EXCEEDED" "$RESULT"

echo
echo "All $PASS smoke tests passed."
unset DEMO_API_KEY
