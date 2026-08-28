const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const PERIOD_DEFINITIONS = Object.freeze([
  { key: "day", label: "Last 24 hours", durationMs: DAY_MS },
  { key: "week", label: "Last 7 days", durationMs: 7 * DAY_MS },
  { key: "month", label: "Last 30 days", durationMs: 30 * DAY_MS },
  { key: "year", label: "Last 365 days", durationMs: 365 * DAY_MS },
  { key: "all", label: "All time", durationMs: null },
]);

export function floorToHour(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date: ${value}`);
  }
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

export function buildPeriodRanges(now, firstHitAt) {
  const end = floorToHour(now);
  const firstHit = floorToHour(firstHitAt);

  return Object.fromEntries(
    PERIOD_DEFINITIONS.map(({ key, label, durationMs }) => [
      key,
      {
        label,
        start: (durationMs === null
          ? firstHit
          : new Date(end.getTime() - durationMs)
        ).toISOString(),
        end: end.toISOString(),
      },
    ]),
  );
}

export function launcherImageUrl(repository, releaseTag, tableId) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new TypeError(`Invalid GitHub repository: ${repository}`);
  }
  return [
    "https://raw.githubusercontent.com",
    encodeURIComponent(owner),
    encodeURIComponent(repo),
    encodeURIComponent(releaseTag),
    "external",
    encodeURIComponent(tableId),
    "launcher.png",
  ].join("/");
}

export async function fetchAllHits(range, requestJson, limit = 100) {
  const hits = [];
  const excludedPathIds = new Set();

  for (let page = 0; page < 100; page += 1) {
    const url = new URL("https://lu-wizard.goatcounter.com/api/v0/stats/hits");
    url.searchParams.set("start", range.start);
    url.searchParams.set("end", range.end);
    url.searchParams.set("limit", String(limit));
    if (excludedPathIds.size > 0) {
      // GoatCounter follows OpenAPI 2's default CSV encoding for query arrays.
      // Repeating exclude_paths only applies the first value.
      url.searchParams.set("exclude_paths", [...excludedPathIds].join(","));
    }

    const payload = await requestJson(url);
    if (!Array.isArray(payload.hits) || typeof payload.more !== "boolean") {
      throw new Error("GoatCounter returned an unexpected stats response");
    }

    let added = 0;
    for (const hit of payload.hits) {
      if (!Number.isInteger(hit.path_id) || excludedPathIds.has(hit.path_id)) {
        continue;
      }
      excludedPathIds.add(hit.path_id);
      hits.push(hit);
      added += 1;
    }

    if (!payload.more) {
      return hits;
    }
    if (added === 0) {
      throw new Error("GoatCounter pagination did not advance");
    }
  }

  throw new Error("GoatCounter pagination exceeded 100 pages");
}

function countHitsByPath(hits) {
  const counts = new Map();
  for (const hit of hits) {
    if (typeof hit.path !== "string" || !Number.isFinite(hit.count)) {
      continue;
    }
    counts.set(hit.path, (counts.get(hit.path) ?? 0) + Math.max(0, hit.count));
  }
  return counts;
}

export function compileDataset({
  generatedAt,
  manifest,
  manifestUrl,
  releaseTag,
  repository,
  ranges,
  hitsByPeriod,
}) {
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new TypeError("Manifest must be an object keyed by table ID");
  }

  const periodCounts = Object.fromEntries(
    PERIOD_DEFINITIONS.map(({ key }) => [
      key,
      countHitsByPath(hitsByPeriod[key] ?? []),
    ]),
  );
  const manifestIds = new Set(Object.keys(manifest));

  const periods = {};
  for (const { key, label } of PERIOD_DEFINITIONS) {
    const counts = periodCounts[key];
    let totalPlays = 0;
    let unmatchedPlays = 0;
    let activeTables = 0;

    for (const [tableId, count] of counts) {
      if (manifestIds.has(tableId)) {
        totalPlays += count;
        if (count > 0) activeTables += 1;
      } else {
        unmatchedPlays += count;
      }
    }

    periods[key] = {
      label,
      start: ranges[key].start,
      end: ranges[key].end,
      totalPlays,
      activeTables,
      unmatchedPlays,
    };
  }

  const tables = {};
  const sortedManifestEntries = Object.entries(manifest).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [tableId, table] of sortedManifestEntries) {
    tables[tableId] = {
      name: table.name || tableId,
      manufacturer: table.manufacturer || null,
      year: Number.isFinite(table.year) ? table.year : null,
      nsfw: Boolean(table.nsfw),
      launcherImage: launcherImageUrl(repository, releaseTag, tableId),
      counts: Object.fromEntries(
        PERIOD_DEFINITIONS.map(({ key }) => [
          key,
          periodCounts[key].get(tableId) ?? 0,
        ]),
      ),
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    source: {
      goatCounter: "https://lu-wizard.goatcounter.com/",
      manifest: manifestUrl,
      manifestRelease: releaseTag,
      manifestRepository: repository,
    },
    periods,
    tables,
  };
}
