import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPeriodRanges,
  compileDataset,
  fetchAllHits,
  launcherImageUrl,
} from "../scripts/stats-lib.mjs";

test("buildPeriodRanges creates rolling UTC windows", () => {
  const ranges = buildPeriodRanges(
    "2026-08-28T16:42:19Z",
    "2026-08-20T10:34:00Z",
  );

  assert.deepEqual(ranges.day, {
    label: "Last 24 hours",
    start: "2026-08-27T16:00:00.000Z",
    end: "2026-08-28T16:00:00.000Z",
  });
  assert.equal(ranges.week.start, "2026-08-21T16:00:00.000Z");
  assert.equal(ranges.month.start, "2026-07-29T16:00:00.000Z");
  assert.equal(ranges.year.start, "2025-08-28T16:00:00.000Z");
  assert.equal(ranges.all.start, "2026-08-20T10:00:00.000Z");
});

test("fetchAllHits paginates by excluding returned path IDs", async () => {
  const urls = [];
  const pages = [
    {
      hits: [
        { path_id: 10, path: "vpx-one", count: 4 },
        { path_id: 11, path: "vpx-two", count: 2 },
      ],
      more: true,
    },
    { hits: [{ path_id: 12, path: "vpx-three", count: 1 }], more: false },
  ];
  const request = async (url) => {
    urls.push(url);
    return pages.shift();
  };

  const hits = await fetchAllHits(
    { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
    request,
    2,
  );

  assert.equal(hits.length, 3);
  assert.equal(urls[1].searchParams.get("exclude_paths"), "10,11");
});

test("compileDataset keys output by stable table ID and resolves metadata", () => {
  const ranges = buildPeriodRanges(
    "2026-08-28T16:42:19Z",
    "2026-08-20T10:34:00Z",
  );
  const dataset = compileDataset({
    generatedAt: "2026-08-28T16:42:19Z",
    manifest: {
      "vpx-two": { name: "Table Two (Original 2026)", manufacturer: "Original", year: 2026 },
      "vpx-one": { name: "Table One (Bally 1992)", manufacturer: "Bally", year: 1992 },
    },
    manifestUrl: "https://example.test/manifest.json",
    releaseTag: "v2.0.9",
    repository: "LegendsUnchained/vpx-standalone-alp4k",
    ranges,
    hitsByPeriod: {
      day: [
        { path: "vpx-one", count: 5 },
        { path: "vpx-retired", count: 3 },
      ],
      week: [{ path: "vpx-one", count: 8 }],
      month: [],
      year: [],
      all: [{ path: "vpx-two", count: 2 }],
    },
  });

  assert.deepEqual(Object.keys(dataset.tables), ["vpx-one", "vpx-two"]);
  assert.equal(dataset.tables["vpx-one"].name, "Table One (Bally 1992)");
  assert.equal(dataset.tables["vpx-one"].counts.day, 5);
  assert.equal(dataset.tables["vpx-two"].counts.day, 0);
  assert.equal(dataset.periods.day.totalPlays, 5);
  assert.equal(dataset.periods.day.unmatchedPlays, 3);
  assert.equal(dataset.periods.day.activeTables, 1);
});

test("launcherImageUrl points at the release-tagged raw file", () => {
  assert.equal(
    launcherImageUrl(
      "LegendsUnchained/vpx-standalone-alp4k",
      "v2.0.9",
      "vpx-madmax",
    ),
    "https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/v2.0.9/external/vpx-madmax/launcher.png",
  );
});
