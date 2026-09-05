import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cachedPeriodStats,
  exportStartDay,
  ingestJsonExport,
  openExportCache,
} from "../scripts/export-cache.mjs";
import { buildHourlyPeriodRanges } from "../scripts/stats-lib.mjs";

async function writeJsonLines(path, rows) {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function fixture(root, hitStats) {
  const directory = join(root, `export-${Date.now()}-${Math.random()}`);
  const nested = join(directory, "goatcounter-export-test");
  await mkdir(nested, { recursive: true });
  await writeJsonLines(join(nested, "paths.jsonl"), [
    { id: 1, path: "vpx-current", title: "Current", event: true },
    { id: 2, path: "vpx-retired", title: "Retired", event: true },
  ]);
  await writeJsonLines(join(nested, "refs.jsonl"), [
    { id: 1, ref: "HA9919 2.1.0-13", ref_scheme: "o" },
    { id: 2, ref: "HA9920 2.1.0-13", ref_scheme: "o" },
  ]);
  await writeJsonLines(join(nested, "hit_stats.jsonl"), hitStats);
  return directory;
}

test("JSON exports replace an overlap and retain older cached aggregates", async () => {
  const root = await mkdtemp(join(tmpdir(), "vpx-stats-export-"));
  const database = openExportCache(join(root, "stats.sqlite"));
  try {
    assert.equal(
      exportStartDay(database, "2026-08-26T00:00:00Z"),
      "2026-08-26T00:00:00.000Z",
    );

    const initial = await fixture(root, [
      { hour: "2026-08-26T10:00:00Z", path_id: 1, ref_id: 1, count: 2 },
      { hour: "2026-09-04T12:00:00Z", path_id: 1, ref_id: 2, count: 3 },
      { hour: "2026-09-04T12:00:00Z", path_id: 2, ref_id: 2, count: 5 },
      { hour: "2026-09-05T15:00:00Z", path_id: 1, ref_id: 1, count: 7 },
    ]);
    await ingestJsonExport(database, initial, {
      startFromDay: "2026-08-26T00:00:00Z",
      exportId: 10,
      finishedAt: "2026-09-05T16:05:00Z",
    });

    assert.equal(
      exportStartDay(database, "2026-08-26T00:00:00Z"),
      "2026-09-04T00:00:00.000Z",
    );

    const overlap = await fixture(root, [
      { hour: "2026-09-04T12:00:00Z", path_id: 1, ref_id: 2, count: 4 },
      { hour: "2026-09-05T15:00:00Z", path_id: 1, ref_id: 1, count: 7 },
    ]);
    await ingestJsonExport(database, overlap, {
      startFromDay: "2026-09-04T00:00:00Z",
      exportId: 11,
      finishedAt: "2026-09-05T17:05:00Z",
    });

    const ranges = buildHourlyPeriodRanges(
      "2026-09-05T16:42:00Z",
      "2026-08-26T00:00:00Z",
    );
    const stats = cachedPeriodStats(database, ranges);

    assert.deepEqual(stats.hitsByPeriod.all, [
      { path: "vpx-current", count: 13 },
    ]);
    assert.deepEqual(stats.hitsByPeriod.day, [
      { path: "vpx-current", count: 7 },
    ]);
    assert.deepEqual(stats.refsByPeriod.all.get("vpx-current"), [
      { name: "HA9919 2.1.0-13", count: 9 },
      { name: "HA9920 2.1.0-13", count: 4 },
    ]);
    assert.equal(stats.refsByPeriod.all.has("vpx-retired"), false);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
