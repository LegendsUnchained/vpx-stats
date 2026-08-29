const DEFAULT_MIN_REQUEST_GAP_MS = 300;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 2 * 60 * 1000;
const RATE_LIMIT_GRACE_MS = 250;

const defaultSleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function nonNegativeNumber(value) {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function readRateLimitHeaders(headers) {
  const limit = nonNegativeNumber(headers.get("x-rate-limit-limit"));
  const remaining = nonNegativeNumber(
    headers.get("x-rate-limit-remaining"),
  );
  const resetSeconds = nonNegativeNumber(headers.get("x-rate-limit-reset"));

  return {
    limit,
    remaining,
    resetSeconds,
  };
}

function retryAfterMilliseconds(headers, now) {
  const value = headers.get("retry-after");
  if (!value) return null;

  const seconds = nonNegativeNumber(value);
  if (seconds !== null) return seconds * 1000;

  const date = new Date(value).getTime();
  return Number.isNaN(date) ? null : Math.max(0, date - now());
}

function responseDetail(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}

export function createGoatCounterClient(
  token,
  {
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    now = Date.now,
    minRequestGapMs = DEFAULT_MIN_REQUEST_GAP_MS,
    maxRateLimitWaitMs = DEFAULT_MAX_RATE_LIMIT_WAIT_MS,
  } = {},
) {
  if (!token) throw new TypeError("A GoatCounter API token is required");

  let nextRequestAt = 0;
  let quotaResumeAt = 0;
  let requestCount = 0;
  let latestRateLimit = {
    limit: null,
    remaining: null,
    resetSeconds: null,
  };

  async function waitUntil(timestamp, reason) {
    const waitMs = Math.max(0, timestamp - now());
    if (waitMs === 0) return;
    if (waitMs > maxRateLimitWaitMs) {
      throw new Error(
        `${reason}; GoatCounter says to retry in ${Math.ceil(waitMs / 1000)}s. ` +
          "This run will stop and let a later scheduled refresh retry.",
      );
    }
    await sleepImpl(waitMs);
  }

  async function goatCounterJson(url) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await waitUntil(quotaResumeAt, "GoatCounter API quota is exhausted");

      const slotAt = Math.max(nextRequestAt, now());
      await waitUntil(slotAt, "GoatCounter request pacing was delayed");
      nextRequestAt = now() + minRequestGapMs;

      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "LegendsUnchained-vpx-stats",
        },
      });
      requestCount += 1;

      latestRateLimit = readRateLimitHeaders(response.headers);
      const resetMs = latestRateLimit.resetSeconds === null
        ? null
        : latestRateLimit.resetSeconds * 1000 + RATE_LIMIT_GRACE_MS;

      if (latestRateLimit.remaining === 0 && resetMs !== null) {
        quotaResumeAt = Math.max(quotaResumeAt, now() + resetMs);
      } else if (
        latestRateLimit.remaining !== null &&
        latestRateLimit.remaining > 0
      ) {
        quotaResumeAt = 0;
      }

      if (response.status === 429) {
        if (attempt === 5) {
          throw new Error("GoatCounter rate limit persisted after 5 attempts");
        }
        const retryAfterMs = retryAfterMilliseconds(response.headers, now);
        const waitMs = Math.max(
          resetMs ?? 0,
          retryAfterMs ?? 0,
          attempt * 1000,
        );
        quotaResumeAt = Math.max(quotaResumeAt, now() + waitMs);
        await waitUntil(quotaResumeAt, "GoatCounter API rate limit was reached");
        continue;
      }

      if (response.status >= 500) {
        if (attempt === 5) {
          throw new Error(
            `GoatCounter request failed after ${attempt} attempts (${response.status})`,
          );
        }
        const retryAfterMs = retryAfterMilliseconds(response.headers, now);
        await sleepImpl(retryAfterMs ?? attempt * 1000);
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `GoatCounter request failed (${response.status}): ` +
            responseDetail(await response.text()),
        );
      }
      return response.json();
    }

    throw new Error("GoatCounter request retry loop ended unexpectedly");
  }

  goatCounterJson.rateLimit = () => ({ ...latestRateLimit });
  goatCounterJson.requestCount = () => requestCount;
  return goatCounterJson;
}
