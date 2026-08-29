#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERIOD_DEFINITIONS,
  buildPeriodRanges,
  canReuseDataset,
  compileDataset,
  fetchAllHits,
  fetchRefsByPath,
  groupPeriodRanges,
} from "./stats-lib.mjs";
import { createGoatCounterClient } from "./goatcounter-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "site/data/stats.json");
const MANIFEST_REPOSITORY = "LegendsUnchained/vpx-standalone-alp4k";
const GITHUB_RELEASE_API = `https://api.github.com/repos/${MANIFEST_REPOSITORY}/releases/latest`;
const PUBLISHED_DATA_URL =
  "https://vpxstats.legendsunchained.com/data/stats.json";
const ALL_TIME_START = "2026-08-26T00:00:00Z";

function outputPathFromArgs(args) {
  const index = args.indexOf("--output");
  if (index === -1) return DEFAULT_OUTPUT;
  if (!args[index + 1]) throw new Error("--output requires a file path");
  return resolve(process.cwd(), args[index + 1]);
}

function forceFromArgs(args) {
  return args.includes("--force");
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

async function writeDataset(dataset, output) {
  await mkdir(dirname(output), { recursive: true });
  const temporaryOutput = `${output}.tmp`;
  await writeFile(temporaryOutput, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  await rename(temporaryOutput, output);
}

async function main() {
  const args = process.argv.slice(2);
  const output = outputPathFromArgs(args);
  const generatedAt = new Date();
  const ranges = buildPeriodRanges(generatedAt, ALL_TIME_START);

  if (!forceFromArgs(args)) {
    try {
      const published = await publicJson(
        `${PUBLISHED_DATA_URL}?refresh=${Date.now()}`,
      );
      if (canReuseDataset(published, ranges)) {
        await writeDataset(published, output);
        console.log(
          `Reused the published ${ranges.all.end} dataset; no GoatCounter requests were needed.`,
        );
        return;
      }
      console.log("Published dataset covers a different range; fetching fresh stats.");
    } catch (error) {
      console.log(
        `Published dataset could not be reused: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const token = process.env.GOATCOUNTER_API_TOKEN;
  if (!token) throw new Error("GOATCOUNTER_API_TOKEN is required");
  const requestJson = createGoatCounterClient(token);

  console.log("Loading the latest ALP4K manifest…");
  const { manifest, manifestUrl, releaseTag } = await loadManifest(process.env.GITHUB_TOKEN);
  console.log(`Resolved ${Object.keys(manifest).length} tables from ${releaseTag}.`);

  const hitsByPeriod = {};
  const refsByPeriod = {};
  const completedRanges = [];

  for (const { range, periodKeys } of groupPeriodRanges(ranges)) {
    const hits = await fetchAllHits(range, requestJson);
    const fallback = completedRanges.find(
      (completed) =>
        completed.range.end === range.end &&
        completed.range.start <= range.start,
    );
    const refsByPath = await fetchRefsByPath(
      range,
      hits,
      requestJson,
      fallback,
    );

    for (const key of periodKeys) {
      hitsByPeriod[key] = hits;
      refsByPeriod[key] = refsByPath;
    }
    completedRanges.push({ range, hits, refsByPath });

    const labels = periodKeys.map(
      (key) => PERIOD_DEFINITIONS.find((period) => period.key === key).label,
    );
    console.log(
      `${labels.join(", ")}: ${hits.length} played table path(s), ` +
        `${refsByPath.size} referrer breakdown(s).`,
    );
  }

  const dataset = compileDataset({
    generatedAt,
    manifest,
    manifestUrl,
    releaseTag,
    repository: MANIFEST_REPOSITORY,
    ranges,
    hitsByPeriod,
    refsByPeriod,
  });

  await writeDataset(dataset, output);
  const rateLimit = requestJson.rateLimit();
  console.log(
    `Wrote ${Object.keys(dataset.tables).length} tables to ${output} after ` +
      `${requestJson.requestCount()} GoatCounter request(s). ` +
      `Quota remaining: ${rateLimit.remaining ?? "unknown"}/${rateLimit.limit ?? "unknown"}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
