import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPeriodRanges,
  canReuseDataset,
  compileDataset,
  fetchAllHits,
  fetchAllRefs,
  fetchRefsByPath,
  groupPeriodRanges,
  launcherImageUrl,
  modelFromReferrer,
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
  assert.equal(ranges.month.start, "2026-08-20T10:00:00.000Z");
  assert.equal(ranges.year.start, "2026-08-20T10:00:00.000Z");
  assert.equal(ranges.all.start, "2026-08-20T10:00:00.000Z");
});

test("period ranges never query before telemetry began", () => {
  const ranges = buildPeriodRanges(
    "2026-08-29T14:32:00Z",
    "2026-08-26T00:00:00Z",
  );

  assert.equal(ranges.day.start, "2026-08-28T14:00:00.000Z");
  for (const period of ["week", "month", "year", "all"]) {
    assert.equal(ranges[period].start, "2026-08-26T00:00:00.000Z");
  }
});

test("groupPeriodRanges deduplicates equal windows widest first", () => {
  const ranges = buildPeriodRanges(
    "2026-08-29T14:32:00Z",
    "2026-08-26T00:00:00Z",
  );
  const groups = groupPeriodRanges(ranges);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].periodKeys, ["week", "month", "year", "all"]);
  assert.deepEqual(groups[1].periodKeys, ["day"]);
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

test("fetchAllRefs paginates referral details by offset", async () => {
  const urls = [];
  const pages = [
    {
      refs: [
        { name: "HA9920 2.1.0-13", count: 4 },
        { name: "HA9919 2.1.0-13", count: 2 },
      ],
      more: true,
    },
    { refs: [{ name: "HA9920 2.1.0-12", count: 1 }], more: false },
  ];
  const request = async (url) => {
    urls.push(url);
    return pages.shift();
  };
  const range = {
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-02-01T00:00:00.000Z",
  };

  const refs = await fetchAllRefs(42, range, request, 2);

  assert.equal(refs.length, 3);
  assert.equal(urls[0].pathname, "/api/v0/stats/hits/42");
  assert.equal(urls[1].searchParams.get("offset"), "2");
});

test("fetchRefsByPath skips paths with no plays", async () => {
  const requested = [];
  const refs = await fetchRefsByPath(
    { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
    [
      { path_id: 10, path: "vpx-one", count: 3 },
      { path_id: 11, path: "vpx-zero", count: 0 },
    ],
    async (url) => {
      requested.push(url.pathname);
      return { refs: [{ name: "HA9920 2.1.0-13", count: 3 }], more: false };
    },
  );

  assert.deepEqual([...refs.keys()], ["vpx-one"]);
  assert.deepEqual(requested, ["/api/v0/stats/hits/10"]);
});

test("fetchRefsByPath reuses wider referrers when counts are unchanged", async () => {
  const widerRange = {
    start: "2026-08-26T00:00:00.000Z",
    end: "2026-08-29T14:00:00.000Z",
  };
  const narrowRange = {
    start: "2026-08-28T14:00:00.000Z",
    end: widerRange.end,
  };
  const reusedRefs = [{ name: "HA9920 2.1.0-13", count: 3 }];
  const requested = [];

  const refs = await fetchRefsByPath(
    narrowRange,
    [
      { path_id: 10, path: "vpx-unchanged", count: 3 },
      { path_id: 11, path: "vpx-changed", count: 1 },
    ],
    async (url) => {
      requested.push(url.pathname);
      return { refs: [{ name: "HA9919 2.1.0-13", count: 1 }], more: false };
    },
    {
      range: widerRange,
      hits: [
        { path_id: 10, path: "vpx-unchanged", count: 3 },
        { path_id: 11, path: "vpx-changed", count: 4 },
      ],
      refsByPath: new Map([["vpx-unchanged", reusedRefs]]),
    },
  );

  assert.equal(refs.get("vpx-unchanged"), reusedRefs);
  assert.deepEqual(requested, ["/api/v0/stats/hits/11"]);
});

test("modelFromReferrer recognizes supported cabinet models", () => {
  assert.equal(modelFromReferrer("HA9919 2.1.0-13"), "HA9919");
  assert.equal(modelFromReferrer("  HA9920   2.1.0-12  "), "HA9920");
  assert.equal(modelFromReferrer("HA9999 2.1.0-13"), null);
  assert.equal(modelFromReferrer("(direct)"), null);
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
    refsByPeriod: {
      day: new Map([
        [
          "vpx-one",
          [
            { name: "HA9919 2.1.0-13", count: 2 },
            { name: "HA9920 2.1.0-13", count: 3 },
          ],
        ],
        ["vpx-retired", [{ name: "HA9920 2.1.0-13", count: 3 }]],
      ]),
      all: new Map([
        ["vpx-two", [{ name: "HA9919 2.1.0-13", count: 2 }]],
      ]),
    },
  });

  assert.equal(dataset.schemaVersion, 2);
  assert.deepEqual(dataset.modelDefinitions, [
    { key: "HA9919", label: "HA9919" },
    { key: "HA9920", label: "HA9920" },
  ]);
  assert.deepEqual(Object.keys(dataset.tables), ["vpx-one", "vpx-two"]);
  assert.equal(dataset.tables["vpx-one"].name, "Table One (Bally 1992)");
  assert.equal(dataset.tables["vpx-one"].counts.day, 5);
  assert.equal(dataset.tables["vpx-two"].counts.day, 0);
  assert.equal(dataset.periods.day.totalPlays, 5);
  assert.equal(dataset.periods.day.unmatchedPlays, 3);
  assert.equal(dataset.periods.day.activeTables, 1);
  assert.equal(dataset.tables["vpx-one"].modelCounts.HA9919.day, 2);
  assert.equal(dataset.tables["vpx-one"].modelCounts.HA9920.day, 3);
  assert.equal(dataset.tables["vpx-two"].modelCounts.HA9919.all, 2);
  assert.deepEqual(dataset.periods.day.models.HA9919, {
    totalPlays: 2,
    activeTables: 1,
    unmatchedPlays: 0,
  });
  assert.deepEqual(dataset.periods.day.models.HA9920, {
    totalPlays: 3,
    activeTables: 1,
    unmatchedPlays: 3,
  });
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

test("canReuseDataset requires the current schema and exact ranges", () => {
  const ranges = buildPeriodRanges(
    "2026-08-29T14:32:00Z",
    "2026-08-26T00:00:00Z",
  );
  const periods = Object.fromEntries(
    Object.entries(ranges).map(([key, range]) => [
      key,
      { ...range, models: { HA9919: {}, HA9920: {} } },
    ]),
  );
  const dataset = {
    schemaVersion: 2,
    modelDefinitions: [{ key: "HA9919" }, { key: "HA9920" }],
    periods,
    tables: {},
  };

  assert.equal(canReuseDataset(dataset, ranges), true);
  dataset.periods.day.end = "2026-08-29T13:00:00.000Z";
  assert.equal(canReuseDataset(dataset, ranges), false);
  dataset.periods.day.end = ranges.day.end;
  delete dataset.periods.day.models.HA9920;
  assert.equal(canReuseDataset(dataset, ranges), false);
  dataset.periods.day.models.HA9920 = {};
  dataset.schemaVersion = 1;
  assert.equal(canReuseDataset(dataset, ranges), false);
});
