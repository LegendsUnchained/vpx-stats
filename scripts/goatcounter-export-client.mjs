import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { readRateLimitHeaders } from "./goatcounter-client.mjs";

const API_ROOT = "https://lu-wizard.goatcounter.com/api/v0";
const MAX_ATTEMPTS = 5;
const RESET_GRACE_MS = 250;

const defaultSleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function nonNegativeNumber(value) {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function retryAfterMilliseconds(headers, now) {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = nonNegativeNumber(value);
  if (seconds !== null) return seconds * 1000;
  const date = new Date(value).getTime();
  return Number.isNaN(date) ? null : Math.max(0, date - now());
}

async function errorBody(response) {
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return "unreadable response body";
  }
}

export function createGoatCounterExportClient(
  token,
  {
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    now = Date.now,
    log = console.warn,
    pollIntervalMs = 2_000,
    maxPolls = 300,
    maxRateLimitWaitMs = 2 * 60 * 1000,
  } = {},
) {
  if (!token) throw new TypeError("A GoatCounter API token is required");

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "LegendsUnchained-vpx-stats",
  };

  async function request(url, options = {}) {
    const { timeoutMs = 30_000, ...fetchOptions } = options;
    const method = fetchOptions.method ?? "GET";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          ...fetchOptions,
          headers: { ...headers, ...fetchOptions.headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw error;
        const waitMs = 500 * 2 ** (attempt - 1);
        log(`${method} ${url} failed; retrying in ${waitMs}ms.`);
        await sleepImpl(waitMs);
        continue;
      }

      if (response.status === 429) {
        const rateLimit = readRateLimitHeaders(response.headers);
        const resetMs = rateLimit.resetSeconds === null
          ? 0
          : rateLimit.resetSeconds * 1000 + RESET_GRACE_MS;
        const waitMs = Math.max(
          resetMs,
          retryAfterMilliseconds(response.headers, now) ?? 0,
          500 * 2 ** (attempt - 1),
        );
        if (waitMs > maxRateLimitWaitMs) {
          throw new Error(
            `GoatCounter ${method} ${url} is rate-limited; retry in ` +
              `${Math.ceil(waitMs / 1000)}s on the next scheduled refresh.`,
          );
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`GoatCounter ${method} ${url} remained rate-limited`);
        }
        log(
          `GoatCounter ${method} ${url} was rate-limited; respecting the ` +
            `${Math.ceil(waitMs / 1000)}s reset.`,
        );
        await sleepImpl(waitMs);
        continue;
      }

      if (response.status >= 500 || [404, 408, 425].includes(response.status)) {
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `GoatCounter ${method} ${url} failed (HTTP ${response.status}): ` +
              await errorBody(response),
          );
        }
        const waitMs = retryAfterMilliseconds(response.headers, now) ??
          500 * 2 ** (attempt - 1);
        log(
          `GoatCounter ${method} ${url} returned HTTP ${response.status}; ` +
            `retrying in ${waitMs}ms.`,
        );
        await sleepImpl(waitMs);
        continue;
      }

      return response;
    }
    throw new Error("GoatCounter export request retry loop ended unexpectedly");
  }

  async function json(response, expectedStatus) {
    if (response.status !== expectedStatus) {
      throw new Error(
        `GoatCounter export request failed (HTTP ${response.status}): ` +
          await errorBody(response),
      );
    }
    return response.json();
  }

  async function start(startFromDay) {
    const response = await request(`${API_ROOT}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "json",
        start_from_day: startFromDay,
      }),
    });
    const details = await json(response, 202);
    if (!Number.isInteger(details.id) || details.id <= 0) {
      throw new Error("GoatCounter returned an invalid export ID");
    }
    return details;
  }

  async function waitForExport(id) {
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (poll > 0) await sleepImpl(pollIntervalMs);
      const response = await request(`${API_ROOT}/export/${id}`);
      const details = await json(response, 200);
      if (details.error) {
        throw new Error(`GoatCounter export ${id} failed: ${details.error}`);
      }
      if (details.finished_at) return details;
    }
    throw new Error(`GoatCounter export ${id} did not finish in time`);
  }

  async function download(id, destination) {
    const url = `${API_ROOT}/export/${id}/download`;
    const response = await request(url, { timeoutMs: 5 * 60 * 1000 });
    if (response.status !== 200 || !response.body) {
      throw new Error(
        `GoatCounter export download failed (HTTP ${response.status}): ` +
          await errorBody(response),
      );
    }
    await pipeline(response.body, createWriteStream(destination, { mode: 0o600 }));
  }

  return { start, waitForExport, download };
}
