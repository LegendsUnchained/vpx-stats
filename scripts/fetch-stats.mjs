#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_DEFINITIONS,
  PERIOD_DEFINITIONS,
  buildPeriodRanges,
  canReuseDataset,
  compileDataset,
  fetchPeriodStats,
} from "./stats-lib.mjs";
import { createGoatCounterClient } from "./goatcounter-client.mjs";
import {
  MANIFEST_REPOSITORY,
  loadManifest,
  publicJson,
  writeDataset,
} from "./dataset-io.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "site/data/stats.json");
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

async function main() {
  const args = process.argv.slice(2);
  const output = outputPathFromArgs(args);
  const generatedAt = new Date();
  const ranges = buildPeriodRanges(generatedAt, ALL_TIME_START);
  let publishedDataset = null;

  if (!forceFromArgs(args)) {
    try {
      publishedDataset = await publicJson(
        `${PUBLISHED_DATA_URL}?refresh=${Date.now()}`,
      );
      if (canReuseDataset(publishedDataset, ranges)) {
        // Labels are presentation metadata and can be updated without querying
        // GoatCounter again for an otherwise-current dataset.
        publishedDataset.modelDefinitions = MODEL_DEFINITIONS;
        await writeDataset(publishedDataset, output);
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

  const { hitsByPeriod, refsByPeriod, groups } = await fetchPeriodStats(
    ranges,
    requestJson,
    publishedDataset,
    new Set(Object.keys(manifest)),
  );
  for (const { periodKeys, hits, metrics } of groups) {
    const labels = periodKeys.map(
      (key) => PERIOD_DEFINITIONS.find((period) => period.key === key).label,
    );
    const publishedReuses = metrics.reusedBySource?.published ?? 0;
    console.log(
      `${labels.join(", ")}: ${hits.length} played table path(s), ` +
        `${metrics.fetched} fetched and ${metrics.reused} reused ` +
        `referrer breakdown(s)` +
        `${publishedReuses ? ` (${publishedReuses} from the previous dataset)` : ""}` +
        `${metrics.skipped ? `; ${metrics.skipped} unmatched path(s) skipped` : ""}.`,
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
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
