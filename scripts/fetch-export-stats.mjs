#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  MANIFEST_REPOSITORY,
  loadManifest,
  writeDataset,
} from "./dataset-io.mjs";
import {
  cachedPeriodStats,
  exportStartDay,
  ingestJsonExport,
  openExportCache,
} from "./export-cache.mjs";
import { createGoatCounterExportClient } from "./goatcounter-export-client.mjs";
import { buildHourlyPeriodRanges, compileDataset } from "./stats-lib.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "site/data/stats.json");
const DEFAULT_STATE_DIRECTORY = resolve(ROOT, ".cache/export");
const ALL_TIME_START = "2026-08-26T00:00:00.000Z";

function valueFromArgs(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return resolve(process.cwd(), args[index + 1]);
}

async function main() {
  const args = process.argv.slice(2);
  const output = valueFromArgs(args, "--output", DEFAULT_OUTPUT);
  const stateDirectory = valueFromArgs(
    args,
    "--state-dir",
    DEFAULT_STATE_DIRECTORY,
  );
  await mkdir(stateDirectory, { recursive: true });

  const token = process.env.GOATCOUNTER_API_TOKEN;
  if (!token) throw new Error("GOATCOUNTER_API_TOKEN is required");

  const database = openExportCache(join(stateDirectory, "stats.sqlite"));
  const temporaryDirectory = await mkdtemp(join(stateDirectory, "export-"));
  try {
    const startFromDay = exportStartDay(database, ALL_TIME_START);
    const archive = join(temporaryDirectory, "goatcounter.zip");
    const extracted = join(temporaryDirectory, "extracted");
    await mkdir(extracted);

    console.log(`Requesting GoatCounter JSON export from ${startFromDay}…`);
    const client = createGoatCounterExportClient(token);
    const started = await client.start(startFromDay);
    const completed = await client.waitForExport(started.id);
    await client.download(started.id, archive);
    await execFileAsync("unzip", ["-q", archive, "-d", extracted]);

    const imported = await ingestJsonExport(database, extracted, {
      startFromDay,
      exportId: completed.id,
      finishedAt: completed.finished_at,
    });
    console.log(
      `Imported export ${completed.id}: ${imported.pathCount} paths, ` +
        `${imported.refCount} referrers, and ${imported.hitCount} hourly rows ` +
        `from ${imported.replaceFrom}.`,
    );

    console.log("Loading the latest ALP4K manifest…");
    const { manifest, manifestUrl, releaseTag } = await loadManifest(
      process.env.GITHUB_TOKEN,
    );
    const generatedAt = new Date();
    const ranges = buildHourlyPeriodRanges(generatedAt, ALL_TIME_START);
    const { hitsByPeriod, refsByPeriod } = cachedPeriodStats(database, ranges);
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
    console.log(
      `Wrote ${Object.keys(dataset.tables).length} tables through ` +
        `${ranges.all.end} to ${output}.`,
    );
  } finally {
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
