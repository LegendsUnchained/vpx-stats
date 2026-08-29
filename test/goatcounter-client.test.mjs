import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoatCounterClient,
  readRateLimitHeaders,
} from "../scripts/goatcounter-client.mjs";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

test("readRateLimitHeaders parses GoatCounter's documented headers", () => {
  const headers = new Headers({
    "X-Rate-Limit-Limit": "500",
    "X-Rate-Limit-Remaining": "417",
    "X-Rate-Limit-Reset": "2875",
  });

  assert.deepEqual(readRateLimitHeaders(headers), {
    limit: 500,
    remaining: 417,
    resetSeconds: 2875,
  });
});

test("client waits for the reset header before retrying a 429", async () => {
  let clock = 0;
  const sleeps = [];
  const responses = [
    jsonResponse(429, {}, {
      "X-Rate-Limit-Limit": "500",
      "X-Rate-Limit-Remaining": "0",
      "X-Rate-Limit-Reset": "2",
    }),
    jsonResponse(200, { hits: [], more: false }, {
      "X-Rate-Limit-Limit": "500",
      "X-Rate-Limit-Remaining": "499",
      "X-Rate-Limit-Reset": "3600",
    }),
  ];
  const client = createGoatCounterClient("test-token", {
    fetchImpl: async () => responses.shift(),
    now: () => clock,
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  assert.deepEqual(await client("https://example.test"), {
    hits: [],
    more: false,
  });
  assert.deepEqual(sleeps, [2250]);
  assert.equal(client.rateLimit().remaining, 499);
});

test("client stops instead of waiting through a long exhausted quota", async () => {
  let calls = 0;
  const client = createGoatCounterClient("test-token", {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, { hits: [], more: false }, {
        "X-Rate-Limit-Limit": "500",
        "X-Rate-Limit-Remaining": "0",
        "X-Rate-Limit-Reset": "600",
      });
    },
    now: () => 0,
    sleepImpl: async () => {},
  });

  await client("https://example.test/first");
  await assert.rejects(
    client("https://example.test/second"),
    /retry in 601s.*later scheduled refresh retry/,
  );
  assert.equal(calls, 1);
});

test("client spaces successful requests below four per second", async () => {
  let clock = 0;
  const sleeps = [];
  const client = createGoatCounterClient("test-token", {
    fetchImpl: async () => jsonResponse(200, { ok: true }, {
      "X-Rate-Limit-Limit": "500",
      "X-Rate-Limit-Remaining": "400",
      "X-Rate-Limit-Reset": "3000",
    }),
    now: () => clock,
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });

  await client("https://example.test/one");
  await client("https://example.test/two");
  assert.deepEqual(sleeps, [300]);
});
