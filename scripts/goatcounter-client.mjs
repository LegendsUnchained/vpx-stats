const DEFAULT_MIN_REQUEST_GAP_MS = 300;
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 2 * 60 * 1000;
const DEFAULT_BASE_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 8 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 1000;
const RATE_LIMIT_GRACE_MS = 250;
const MAX_ATTEMPTS = 5;
const RETRYABLE_STATUSES = new Set([404, 408, 425]);

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

async function responseBodyDetail(response) {
  try {
    return responseDetail(await response.text());
  } catch (error) {
    return `response body could not be read: ${errorDetail(error)}`;
  }
}

function requestUrl(value) {
  return value instanceof URL ? value.href : String(value);
}

function errorDetail(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!cause || typeof cause !== "object") return error.message;
  const code = typeof cause.code === "string" ? `${cause.code}: ` : "";
  const message =
    typeof cause.message === "string" ? cause.message : String(cause);
  return `${error.message} (${code}${message})`;
}

export function createGoatCounterClient(
  token,
  {
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    now = Date.now,
    random = Math.random,
    log = console.warn,
    minRequestGapMs = DEFAULT_MIN_REQUEST_GAP_MS,
    maxRateLimitWaitMs = DEFAULT_MAX_RATE_LIMIT_WAIT_MS,
    baseRetryDelayMs = DEFAULT_BASE_RETRY_DELAY_MS,
    maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
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

  function retryDelay(attempt) {
    const exponential = Math.min(
      maxRetryDelayMs,
      baseRetryDelayMs * 2 ** (attempt - 1),
    );
    // Keep retries from synchronizing across several scheduled clients.
    return Math.max(0, Math.round(exponential * (0.75 + random() * 0.5)));
  }

  async function waitForRetry(url, attempt, reason, waitMs) {
    log(
      `GoatCounter GET ${requestUrl(url)} failed on attempt ` +
        `${attempt}/${MAX_ATTEMPTS} (${reason}); retrying in ${waitMs}ms.`,
    );
    await sleepImpl(waitMs);
  }

  async function goatCounterJson(url) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await waitUntil(quotaResumeAt, "GoatCounter API quota is exhausted");

      const slotAt = Math.max(nextRequestAt, now());
      await waitUntil(slotAt, "GoatCounter request pacing was delayed");
      nextRequestAt = now() + minRequestGapMs;

      requestCount += 1;
      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "LegendsUnchained-vpx-stats",
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        const detail = errorDetail(error);
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `GoatCounter GET ${requestUrl(url)} failed after ` +
              `${attempt} attempts: ${detail}`,
            { cause: error },
          );
        }
        await waitForRetry(url, attempt, detail, retryDelay(attempt));
        continue;
      }

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
        const retryAfterMs = retryAfterMilliseconds(response.headers, now);
        const waitMs = Math.max(
          resetMs ?? 0,
          retryAfterMs ?? 0,
          retryDelay(attempt),
        );
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `GoatCounter GET ${requestUrl(url)} remained rate-limited after ` +
              `${attempt} attempts`,
          );
        }
        quotaResumeAt = Math.max(quotaResumeAt, now() + waitMs);
        log(
          `GoatCounter GET ${requestUrl(url)} was rate-limited on attempt ` +
            `${attempt}/${MAX_ATTEMPTS}; retrying after the ${Math.ceil(waitMs / 1000)}s reset.`,
        );
        await waitUntil(
          quotaResumeAt,
          `GoatCounter GET ${requestUrl(url)} was rate-limited`,
        );
        continue;
      }

      if (RETRYABLE_STATUSES.has(response.status) || response.status >= 500) {
        const detail = await responseBodyDetail(response);
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `GoatCounter GET ${requestUrl(url)} failed after ${attempt} ` +
              `attempts (HTTP ${response.status}): ${detail}`,
          );
        }
        const retryAfterMs = retryAfterMilliseconds(response.headers, now);
        await waitForRetry(
          url,
          attempt,
          `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          retryAfterMs ?? retryDelay(attempt),
        );
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `GoatCounter GET ${requestUrl(url)} failed (HTTP ${response.status}): ` +
            await responseBodyDetail(response),
        );
      }
      try {
        return await response.json();
      } catch (error) {
        const detail = errorDetail(error);
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `GoatCounter GET ${requestUrl(url)} returned an unreadable ` +
              `response after ${attempt} attempts: ${detail}`,
            { cause: error },
          );
        }
        await waitForRetry(url, attempt, detail, retryDelay(attempt));
      }
    }

    throw new Error("GoatCounter request retry loop ended unexpectedly");
  }

  goatCounterJson.rateLimit = () => ({ ...latestRateLimit });
  goatCounterJson.requestCount = () => requestCount;
  return goatCounterJson;
}
