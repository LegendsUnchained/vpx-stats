const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const PERIOD_DEFINITIONS = Object.freeze([
  { key: "day", label: "Last 24 hours", durationMs: DAY_MS },
  { key: "week", label: "Last 7 days", durationMs: 7 * DAY_MS },
  { key: "month", label: "Last 30 days", durationMs: 30 * DAY_MS },
  { key: "year", label: "Last 365 days", durationMs: 365 * DAY_MS },
  { key: "all", label: "All time", durationMs: null },
]);

export const MODEL_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "HA9919", label: "HA9919" }),
  Object.freeze({ key: "HA9920", label: "HA9920" }),
]);

const MODEL_KEYS = new Set(MODEL_DEFINITIONS.map(({ key }) => key));

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
    PERIOD_DEFINITIONS.map(({ key, label, durationMs }) => {
      const naturalStart = durationMs === null
        ? firstHit
        : new Date(end.getTime() - durationMs);
      const start = new Date(
        Math.max(firstHit.getTime(), naturalStart.getTime()),
      );

      return [
        key,
        {
          label,
          start: start.toISOString(),
          end: end.toISOString(),
        },
      ];
    }),
  );
}

export function groupPeriodRanges(ranges) {
  const groups = new Map();

  for (const { key } of PERIOD_DEFINITIONS) {
    const range = ranges[key];
    if (!range?.start || !range?.end) {
      throw new TypeError(`Missing range for period: ${key}`);
    }
    const identity = `${range.start}\u0000${range.end}`;
    const existing = groups.get(identity);
    if (existing) {
      existing.periodKeys.push(key);
    } else {
      groups.set(identity, {
        range,
        periodKeys: [key],
      });
    }
  }

  // Fetch the widest range first so narrower ranges can reuse its referrers.
  return [...groups.values()].sort((a, b) =>
    a.range.start.localeCompare(b.range.start),
  );
}

export function canReuseDataset(dataset, ranges) {
  if (
    dataset?.schemaVersion !== 2 ||
    !dataset.tables ||
    !dataset.periods ||
    !Array.isArray(dataset.modelDefinitions)
  ) {
    return false;
  }

  const models = new Set(dataset.modelDefinitions.map(({ key }) => key));
  if ([...MODEL_KEYS].some((model) => !models.has(model))) return false;

  return PERIOD_DEFINITIONS.every(({ key }) => {
    const period = dataset.periods[key];
    return (
      period?.start === ranges[key]?.start &&
      period?.end === ranges[key]?.end &&
      [...MODEL_KEYS].every((model) => period.models?.[model])
    );
  });
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

export async function fetchAllRefs(pathId, range, requestJson, limit = 100) {
  if (!Number.isInteger(pathId) || pathId <= 0) {
    throw new TypeError(`Invalid GoatCounter path ID: ${pathId}`);
  }

  const refs = [];
  let offset = 0;

  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      `https://lu-wizard.goatcounter.com/api/v0/stats/hits/${pathId}`,
    );
    url.searchParams.set("start", range.start);
    url.searchParams.set("end", range.end);
    url.searchParams.set("limit", String(limit));
    if (offset > 0) url.searchParams.set("offset", String(offset));

    const payload = await requestJson(url);
    if (!Array.isArray(payload.refs) || typeof payload.more !== "boolean") {
      throw new Error("GoatCounter returned an unexpected referrer response");
    }

    refs.push(...payload.refs);
    if (!payload.more) return refs;
    if (payload.refs.length === 0) {
      throw new Error("GoatCounter referrer pagination did not advance");
    }
    offset += payload.refs.length;
  }

  throw new Error("GoatCounter referrer pagination exceeded 100 pages");
}

export async function fetchRefsByPath(
  range,
  hits,
  requestJson,
  fallback = null,
) {
  const refsByPath = new Map();
  const canUseFallback =
    fallback?.range?.end === range.end &&
    fallback.range.start <= range.start &&
    fallback.refsByPath instanceof Map;
  const fallbackCounts = canUseFallback
    ? countHitsByPath(fallback.hits ?? [])
    : new Map();

  for (const hit of hits) {
    if (
      typeof hit.path !== "string" ||
      !Number.isInteger(hit.path_id) ||
      !Number.isFinite(hit.count) ||
      hit.count <= 0
    ) {
      continue;
    }
    if (
      fallbackCounts.get(hit.path) === hit.count &&
      fallback.refsByPath.has(hit.path)
    ) {
      refsByPath.set(hit.path, fallback.refsByPath.get(hit.path));
      continue;
    }
    refsByPath.set(
      hit.path,
      await fetchAllRefs(hit.path_id, range, requestJson),
    );
  }

  return refsByPath;
}

export function modelFromReferrer(value) {
  if (typeof value !== "string") return null;
  const [model] = value.trim().split(/\s+/, 1);
  return MODEL_KEYS.has(model) ? model : null;
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

function countModelsByPath(refsByPath) {
  const counts = Object.fromEntries(
    MODEL_DEFINITIONS.map(({ key }) => [key, new Map()]),
  );
  const entries = refsByPath instanceof Map
    ? refsByPath
    : Object.entries(refsByPath ?? {});

  for (const [path, refs] of entries) {
    if (typeof path !== "string" || !Array.isArray(refs)) continue;
    for (const ref of refs) {
      const model = modelFromReferrer(ref?.name);
      if (!model || !Number.isFinite(ref.count)) continue;
      const count = Math.max(0, ref.count);
      counts[model].set(path, (counts[model].get(path) ?? 0) + count);
    }
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
  refsByPeriod = {},
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
  const periodModelCounts = Object.fromEntries(
    PERIOD_DEFINITIONS.map(({ key }) => [
      key,
      countModelsByPath(refsByPeriod[key]),
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
      models: Object.fromEntries(
        MODEL_DEFINITIONS.map(({ key: model }) => {
          let modelTotalPlays = 0;
          let modelActiveTables = 0;
          let modelUnmatchedPlays = 0;

          for (const [tableId, count] of periodModelCounts[key][model]) {
            if (manifestIds.has(tableId)) {
              modelTotalPlays += count;
              if (count > 0) modelActiveTables += 1;
            } else {
              modelUnmatchedPlays += count;
            }
          }

          return [
            model,
            {
              totalPlays: modelTotalPlays,
              activeTables: modelActiveTables,
              unmatchedPlays: modelUnmatchedPlays,
            },
          ];
        }),
      ),
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
      modelCounts: Object.fromEntries(
        MODEL_DEFINITIONS.map(({ key: model }) => [
          model,
          Object.fromEntries(
            PERIOD_DEFINITIONS.map(({ key }) => [
              key,
              periodModelCounts[key][model].get(tableId) ?? 0,
            ]),
          ),
        ]),
      ),
    };
  }

  return {
    schemaVersion: 2,
    generatedAt: new Date(generatedAt).toISOString(),
    modelDefinitions: MODEL_DEFINITIONS,
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
