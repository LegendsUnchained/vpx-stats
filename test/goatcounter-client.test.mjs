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
    log: () => {},
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
    log: () => {},
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
    log: () => {},
  });

  await client("https://example.test/one");
  await client("https://example.test/two");
  assert.deepEqual(sleeps, [300]);
});

test("client retries transport failures with the URL and socket cause logged", async () => {
  let clock = 0;
  let calls = 0;
  const sleeps = [];
  const logs = [];
  const client = createGoatCounterClient("test-token", {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection reset by peer"), {
            code: "ECONNRESET",
          }),
        });
      }
      return jsonResponse(200, { ok: true });
    },
    now: () => clock,
    random: () => 0.5,
    minRequestGapMs: 0,
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    log: (message) => logs.push(message),
  });

  assert.deepEqual(await client("https://example.test/stats?period=all"), {
    ok: true,
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
  assert.match(logs[0], /example\.test\/stats\?period=all/);
  assert.match(logs[0], /ECONNRESET: connection reset by peer/);
  assert.match(logs[0], /attempt 1\/5/);
});

test("client retries transient 404 responses", async () => {
  let calls = 0;
  const sleeps = [];
  const client = createGoatCounterClient("test-token", {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(404, { error: "not found" })
        : jsonResponse(200, { refs: [], more: false });
    },
    random: () => 0.5,
    minRequestGapMs: 0,
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    log: () => {},
  });

  assert.deepEqual(await client("https://example.test/path/42"), {
    refs: [],
    more: false,
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [500]);
});

test("client retries an interrupted or malformed response body", async () => {
  let calls = 0;
  const client = createGoatCounterClient("test-token", {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("{", { status: 200 })
        : jsonResponse(200, { ok: true });
    },
    random: () => 0.5,
    minRequestGapMs: 0,
    sleepImpl: async () => {},
    log: () => {},
  });

  assert.deepEqual(await client("https://example.test/stats"), { ok: true });
  assert.equal(calls, 2);
});

test("client reports the URL and cause after transport retries are exhausted", async () => {
  const client = createGoatCounterClient("test-token", {
    fetchImpl: async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
      });
    },
    minRequestGapMs: 0,
    baseRetryDelayMs: 0,
    sleepImpl: async () => {},
    log: () => {},
  });

  await assert.rejects(
    client("https://example.test/stats/hits/99"),
    /GET https:\/\/example\.test\/stats\/hits\/99 failed after 5 attempts:.*UND_ERR_SOCKET: socket closed/,
  );
  assert.equal(client.requestCount(), 5);
});
