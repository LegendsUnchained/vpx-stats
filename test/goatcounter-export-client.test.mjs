import assert from "node:assert/strict";
import test from "node:test";

import { createGoatCounterExportClient } from "../scripts/goatcounter-export-client.mjs";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("export client starts then polls a background JSON export", async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    jsonResponse(202, { id: 42, finished_at: null }),
    jsonResponse(200, { id: 42, finished_at: null, error: null }),
    jsonResponse(200, {
      id: 42,
      finished_at: "2026-09-05T17:00:02Z",
      error: null,
    }),
  ];
  const client = createGoatCounterExportClient("test-token", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    pollIntervalMs: 10,
  });

  const started = await client.start("2026-08-26T00:00:00.000Z");
  const completed = await client.waitForExport(started.id);

  assert.equal(completed.finished_at, "2026-09-05T17:00:02Z");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    format: "json",
    start_from_day: "2026-08-26T00:00:00.000Z",
  });
  assert.match(calls[1].url, /\/export\/42$/);
  assert.deepEqual(sleeps, [10]);
});

test("export client honors a long GoatCounter reset without busy retrying", async () => {
  let calls = 0;
  const client = createGoatCounterExportClient("test-token", {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(429, { error: "rate limited" }, {
        "X-Rate-Limit-Limit": "1",
        "X-Rate-Limit-Remaining": "0",
        "X-Rate-Limit-Reset": "3500",
        "Retry-After": "3500",
      });
    },
    sleepImpl: async () => {
      throw new Error("should not wait through an hourly reset");
    },
  });

  await assert.rejects(
    client.start("2026-08-26T00:00:00.000Z"),
    /rate-limited; retry in 3501s on the next scheduled refresh/,
  );
  assert.equal(calls, 1);
});
