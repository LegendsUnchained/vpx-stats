import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPeriodRanges,
  buildHourlyPeriodRanges,
  canReuseDataset,
  compileDataset,
  datasetRefFallback,
  fetchAllHits,
  fetchAllRefs,
  fetchPeriodStats,
  fetchRefsByPath,
  groupPeriodRanges,
  launcherImageUrl,
  modelFromReferrer,
} from "../scripts/stats-lib.mjs";

test("buildPeriodRanges creates rolling half-hour UTC windows", () => {
  const ranges = buildPeriodRanges(
    "2026-08-28T16:42:19Z",
    "2026-08-20T10:34:00Z",
  );

  assert.deepEqual(ranges.day, {
    label: "Last 24 hours",
    start: "2026-08-27T16:30:00.000Z",
    end: "2026-08-28T16:30:00.000Z",
  });
  assert.equal(ranges.week.start, "2026-08-21T16:30:00.000Z");
  assert.equal(ranges.month.start, "2026-08-20T10:30:00.000Z");
  assert.equal(ranges.year.start, "2026-08-20T10:30:00.000Z");
  assert.equal(ranges.all.start, "2026-08-20T10:30:00.000Z");
});

test("period ranges never query before telemetry began", () => {
  const ranges = buildPeriodRanges(
    "2026-08-29T14:32:00Z",
    "2026-08-26T00:00:00Z",
  );

  assert.equal(ranges.day.start, "2026-08-28T14:30:00.000Z");
  for (const period of ["week", "month", "year", "all"]) {
    assert.equal(ranges[period].start, "2026-08-26T00:00:00.000Z");
  }
});

test("export period ranges use completed UTC hours", () => {
  const ranges = buildHourlyPeriodRanges(
    "2026-09-05T16:42:19Z",
    "2026-08-26T00:00:00Z",
  );

  assert.equal(ranges.day.start, "2026-09-04T16:00:00.000Z");
  assert.equal(ranges.day.end, "2026-09-05T16:00:00.000Z");
  assert.equal(ranges.all.start, "2026-08-26T00:00:00.000Z");
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
  const metrics = {};

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
      source: "current-range",
      range: widerRange,
      hits: [
        { path_id: 10, path: "vpx-unchanged", count: 3 },
        { path_id: 11, path: "vpx-changed", count: 4 },
      ],
      refsByPath: new Map([["vpx-unchanged", reusedRefs]]),
    },
    metrics,
  );

  assert.equal(refs.get("vpx-unchanged"), reusedRefs);
  assert.deepEqual(requested, ["/api/v0/stats/hits/11"]);
  assert.deepEqual(metrics, {
    fetched: 1,
    reused: 1,
    reusedBySource: { "current-range": 1 },
  });
});

test("datasetRefFallback reconstructs exact published model aggregates", () => {
  const fallback = datasetRefFallback(
    {
      schemaVersion: 2,
      periods: {
        all: {
          start: "2026-08-26T00:00:00.000Z",
          end: "2026-08-29T14:00:00.000Z",
        },
      },
      tables: {
        "vpx-known": {
          counts: { all: 5 },
          modelCounts: {
            HA9919: { all: 2 },
            HA9920: { all: 3 },
          },
        },
        "vpx-direct": {
          counts: { all: 2 },
          modelCounts: {
            HA9919: { all: 0 },
            HA9920: { all: 0 },
          },
        },
        "vpx-invalid": {
          counts: { all: 1 },
          modelCounts: {
            HA9919: { all: 2 },
            HA9920: { all: 0 },
          },
        },
      },
    },
    "all",
  );

  assert.deepEqual(fallback.range, {
    start: "2026-08-26T00:00:00.000Z",
    end: "2026-08-29T14:00:00.000Z",
  });
  assert.deepEqual(fallback.hits, [
    { path: "vpx-known", count: 5 },
    { path: "vpx-direct", count: 2 },
  ]);
  assert.deepEqual(fallback.refsByPath.get("vpx-known"), [
    { name: "HA9919 cached aggregate", count: 2 },
    { name: "HA9920 cached aggregate", count: 3 },
  ]);
  assert.deepEqual(fallback.refsByPath.get("vpx-direct"), []);
  assert.equal(fallback.refsByPath.has("vpx-invalid"), false);
});

test("fetchRefsByPath reuses an earlier same-start published aggregate", async () => {
  const requested = [];
  const metrics = {};
  const refs = await fetchRefsByPath(
    {
      start: "2026-08-26T00:00:00.000Z",
      end: "2026-08-29T15:00:00.000Z",
    },
    [
      { path_id: 10, path: "vpx-unchanged", count: 5 },
      { path_id: 11, path: "vpx-changed", count: 6 },
    ],
    async (url) => {
      requested.push(url.pathname);
      return { refs: [{ name: "HA9920 2.1.0-13", count: 6 }], more: false };
    },
    {
      source: "published",
      range: {
        start: "2026-08-26T00:00:00.000Z",
        end: "2026-08-29T14:00:00.000Z",
      },
      hits: [
        { path: "vpx-unchanged", count: 5 },
        { path: "vpx-changed", count: 5 },
      ],
      refsByPath: new Map([
        ["vpx-unchanged", [{ name: "HA9919 cached aggregate", count: 5 }]],
        ["vpx-changed", [{ name: "HA9919 cached aggregate", count: 5 }]],
      ]),
    },
    metrics,
  );

  assert.equal(refs.get("vpx-unchanged")[0].count, 5);
  assert.deepEqual(requested, ["/api/v0/stats/hits/11"]);
  assert.deepEqual(metrics, {
    fetched: 1,
    reused: 1,
    reusedBySource: { published: 1 },
  });
});

test("fetchRefsByPath does not reuse a shifted rolling window", async () => {
  const requested = [];
  await fetchRefsByPath(
    {
      start: "2026-08-28T15:00:00.000Z",
      end: "2026-08-29T15:00:00.000Z",
    },
    [{ path_id: 10, path: "vpx-one", count: 5 }],
    async (url) => {
      requested.push(url.pathname);
      return { refs: [], more: false };
    },
    {
      source: "published",
      range: {
        start: "2026-08-28T14:00:00.000Z",
        end: "2026-08-29T14:00:00.000Z",
      },
      hits: [{ path: "vpx-one", count: 5 }],
      refsByPath: new Map([["vpx-one", []]]),
    },
  );

  assert.deepEqual(requested, ["/api/v0/stats/hits/10"]);
});

test("fetchPeriodStats reuses the previous fixed window end to end", async () => {
  const ranges = buildPeriodRanges(
    "2026-08-30T01:30:00Z",
    "2026-08-26T00:00:00Z",
  );
  const previousPeriods = Object.fromEntries(
    Object.entries(buildPeriodRanges(
      "2026-08-30T00:30:00Z",
      "2026-08-26T00:00:00Z",
    )).map(([key, range]) => [key, { ...range }]),
  );
  const periodCounts = {
    day: 5,
    week: 5,
    month: 5,
    year: 5,
    all: 5,
  };
  const previousDataset = {
    schemaVersion: 2,
    periods: previousPeriods,
    tables: {
      "vpx-unchanged": {
        counts: { ...periodCounts },
        modelCounts: {
          HA9919: { day: 2, week: 2, month: 2, year: 2, all: 2 },
          HA9920: { day: 3, week: 3, month: 3, year: 3, all: 3 },
        },
      },
      "vpx-changed": {
        counts: { ...periodCounts },
        modelCounts: {
          HA9919: { day: 5, week: 5, month: 5, year: 5, all: 5 },
          HA9920: { day: 0, week: 0, month: 0, year: 0, all: 0 },
        },
      },
    },
  };
  const urls = [];

  const result = await fetchPeriodStats(
    ranges,
    async (url) => {
      urls.push(url);
      if (url.pathname === "/api/v0/stats/hits") {
        return {
          hits: [
            { path_id: 10, path: "vpx-unchanged", count: 5 },
            { path_id: 11, path: "vpx-changed", count: 6 },
          ],
          more: false,
        };
      }
      assert.equal(url.pathname, "/api/v0/stats/hits/11");
      return {
        refs: [{ name: "HA9920 2.1.0-13", count: 6 }],
        more: false,
      };
    },
    previousDataset,
  );

  assert.equal(urls.length, 3);
  assert.equal(
    urls.filter((url) => url.pathname === "/api/v0/stats/hits/11").length,
    1,
  );
  assert.equal(result.refsByPeriod.all.get("vpx-unchanged")[0].count, 2);
  assert.equal(result.refsByPeriod.all.get("vpx-changed")[0].count, 6);
  assert.equal(
    result.refsByPeriod.day.get("vpx-unchanged"),
    result.refsByPeriod.all.get("vpx-unchanged"),
  );
  assert.deepEqual(result.groups[0].metrics, {
    fetched: 1,
    reused: 1,
    reusedBySource: { published: 1 },
    skipped: 0,
  });
  assert.deepEqual(result.groups[1].metrics, {
    fetched: 0,
    reused: 2,
    reusedBySource: { "current-range": 2 },
    skipped: 0,
  });
});

test("fetchPeriodStats only fetches referrers for allowed table paths", async () => {
  const range = {
    label: "Test range",
    start: "2026-08-26T00:00:00.000Z",
    end: "2026-08-30T00:00:00.000Z",
  };
  const ranges = Object.fromEntries(
    ["day", "week", "month", "year", "all"].map((key) => [key, range]),
  );
  const requested = [];

  const result = await fetchPeriodStats(
    ranges,
    async (url) => {
      requested.push(url.pathname);
      if (url.pathname === "/api/v0/stats/hits") {
        return {
          hits: [
            { path_id: 10, path: "vpx-current", count: 4 },
            { path_id: 11, path: "vpx-retired", count: 3 },
          ],
          more: false,
        };
      }
      assert.equal(url.pathname, "/api/v0/stats/hits/10");
      return {
        refs: [{ name: "HA9919 2.1.0-13", count: 4 }],
        more: false,
      };
    },
    null,
    new Set(["vpx-current"]),
  );

  assert.deepEqual(requested, [
    "/api/v0/stats/hits",
    "/api/v0/stats/hits/10",
  ]);
  assert.equal(result.hitsByPeriod.all.length, 2);
  assert.equal(result.refsByPeriod.all.has("vpx-retired"), false);
  assert.deepEqual(result.groups[0].metrics, {
    fetched: 1,
    reused: 0,
    reusedBySource: {},
    skipped: 1,
  });
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
    { key: "HA9919", label: "HDP" },
    { key: "HA9920", label: "4KP" },
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
