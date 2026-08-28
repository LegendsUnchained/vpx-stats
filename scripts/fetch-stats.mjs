#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERIOD_DEFINITIONS,
  buildPeriodRanges,
  compileDataset,
  fetchAllHits,
} from "./stats-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "site/data/stats.json");
const MANIFEST_REPOSITORY = "LegendsUnchained/vpx-standalone-alp4k";
const GITHUB_RELEASE_API = `https://api.github.com/repos/${MANIFEST_REPOSITORY}/releases/latest`;
const MIN_REQUEST_GAP_MS = 275;
// Matches go-vpx-launcher's telemetryEpoch. It safely predates every real
// table-play event without requiring the API token to have site-read access.
const ALL_TIME_START = "2020-01-01T00:00:00Z";

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function outputPathFromArgs(args) {
  const index = args.indexOf("--output");
  if (index === -1) return DEFAULT_OUTPUT;
  if (!args[index + 1]) throw new Error("--output requires a file path");
  return resolve(process.cwd(), args[index + 1]);
}

function responseDetail(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}

async function publicJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json, application/json",
      "User-Agent": "LegendsUnchained-vpx-stats",
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed (${response.status}): ${responseDetail(await response.text())}`,
    );
  }
  return response.json();
}

function createGoatCounterClient(token) {
  let nextRequestAt = 0;

  return async function goatCounterJson(url) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const waitForSlot = Math.max(0, nextRequestAt - Date.now());
      if (waitForSlot > 0) await sleep(waitForSlot);
      nextRequestAt = Date.now() + MIN_REQUEST_GAP_MS;

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "LegendsUnchained-vpx-stats",
        },
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt === 5) {
          throw new Error(`GoatCounter request failed after ${attempt} attempts (${response.status})`);
        }
        const resetSeconds = Number(response.headers.get("x-rate-limit-reset"));
        await sleep(Number.isFinite(resetSeconds) ? Math.max(1000, resetSeconds * 1000) : attempt * 1000);
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `GoatCounter request failed (${response.status}): ${responseDetail(await response.text())}`,
        );
      }
      return response.json();
    }

    throw new Error("GoatCounter request retry loop ended unexpectedly");
  };
}

async function loadManifest(githubToken) {
  const headers = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
  const release = await publicJson(GITHUB_RELEASE_API, headers);
  const asset = release.assets?.find(({ name }) => name === "manifest.json");
  if (!release.tag_name || !asset?.browser_download_url) {
    throw new Error("Latest ALP4K release does not contain manifest.json");
  }

  const manifest = await publicJson(asset.browser_download_url);
  return {
    manifest,
    manifestUrl: asset.browser_download_url,
    releaseTag: release.tag_name,
  };
}

async function main() {
  const token = process.env.GOATCOUNTER_API_TOKEN;
  if (!token) {
    throw new Error("GOATCOUNTER_API_TOKEN is required");
  }

  const output = outputPathFromArgs(process.argv.slice(2));
  const requestJson = createGoatCounterClient(token);
  const generatedAt = new Date();

  console.log("Loading the latest ALP4K manifest…");
  const { manifest, manifestUrl, releaseTag } = await loadManifest(process.env.GITHUB_TOKEN);
  console.log(`Resolved ${Object.keys(manifest).length} tables from ${releaseTag}.`);

  const ranges = buildPeriodRanges(generatedAt, ALL_TIME_START);
  const hitsByPeriod = {};

  for (const { key, label } of PERIOD_DEFINITIONS) {
    hitsByPeriod[key] = await fetchAllHits(ranges[key], requestJson);
    console.log(`${label}: ${hitsByPeriod[key].length} played table path(s).`);
  }

  const dataset = compileDataset({
    generatedAt,
    manifest,
    manifestUrl,
    releaseTag,
    repository: MANIFEST_REPOSITORY,
    ranges,
    hitsByPeriod,
  });

  await mkdir(dirname(output), { recursive: true });
  const temporaryOutput = `${output}.tmp`;
  await writeFile(temporaryOutput, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  await rename(temporaryOutput, output);
  console.log(`Wrote ${Object.keys(dataset.tables).length} tables to ${output}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
