import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { PERIOD_DEFINITIONS } from "./stats-lib.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date: ${value}`);
  }
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function requiredInteger(value, name, { positive = false } = {}) {
  if (!Number.isInteger(value) || (positive && value <= 0)) {
    throw new TypeError(`Invalid ${name}: ${value}`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(path, name);
      if (nested) return nested;
    } else if (entry.isFile() && basename(path) === name) {
      return path;
    }
  }
  return null;
}

async function forEachJsonLine(path, callback) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      await callback(JSON.parse(line));
    } catch (error) {
      throw new Error(`${path}:${lineNumber}: ${error.message}`, { cause: error });
    }
  }
}

export function openExportCache(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paths (
      path_id INTEGER PRIMARY KEY,
      path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refs (
      ref_id INTEGER PRIMARY KEY,
      ref TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hit_stats (
      hour TEXT NOT NULL,
      path_id INTEGER NOT NULL,
      ref_id INTEGER NOT NULL,
      count INTEGER NOT NULL CHECK (count >= 0),
      PRIMARY KEY (hour, path_id, ref_id)
    );
    CREATE INDEX IF NOT EXISTS hit_stats_hour ON hit_stats (hour);
  `);
  return database;
}

export function exportStartDay(database, firstHitAt) {
  const firstDay = utcDay(firstHitAt);
  const latest = database.prepare(
    "SELECT max(hour) AS hour FROM hit_stats",
  ).get()?.hour;
  if (!latest) return firstDay.toISOString();

  const overlapDay = new Date(utcDay(latest).getTime() - DAY_MS);
  return new Date(
    Math.max(firstDay.getTime(), overlapDay.getTime()),
  ).toISOString();
}

export async function ingestJsonExport(
  database,
  extractedDirectory,
  { startFromDay, exportId = null, finishedAt = null } = {},
) {
  const pathsFile = await findFile(extractedDirectory, "paths.jsonl");
  const refsFile = await findFile(extractedDirectory, "refs.jsonl");
  const hitsFile = await findFile(extractedDirectory, "hit_stats.jsonl");
  if (!pathsFile || !refsFile || !hitsFile) {
    throw new Error("GoatCounter JSON export is missing paths, refs, or hit_stats");
  }

  const replaceFrom = utcDay(startFromDay).toISOString();
  const upsertPath = database.prepare(`
    INSERT INTO paths (path_id, path) VALUES (?, ?)
    ON CONFLICT (path_id) DO UPDATE SET path = excluded.path
  `);
  const upsertRef = database.prepare(`
    INSERT INTO refs (ref_id, ref) VALUES (?, ?)
    ON CONFLICT (ref_id) DO UPDATE SET ref = excluded.ref
  `);
  const insertHit = database.prepare(`
    INSERT INTO hit_stats (hour, path_id, ref_id, count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (hour, path_id, ref_id) DO UPDATE SET count = excluded.count
  `);
  const setMetadata = database.prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `);

  let pathCount = 0;
  let refCount = 0;
  let hitCount = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    await forEachJsonLine(pathsFile, (row) => {
      upsertPath.run(
        requiredInteger(row.id, "path id", { positive: true }),
        requiredString(row.path, "path"),
      );
      pathCount += 1;
    });
    await forEachJsonLine(refsFile, (row) => {
      upsertRef.run(
        requiredInteger(row.id, "referrer id", { positive: true }),
        requiredString(row.ref, "referrer"),
      );
      refCount += 1;
    });

    database.prepare("DELETE FROM hit_stats WHERE hour >= ?").run(replaceFrom);
    await forEachJsonLine(hitsFile, (row) => {
      const hour = new Date(requiredString(row.hour, "hit hour"));
      if (Number.isNaN(hour.getTime())) {
        throw new TypeError(`Invalid hit hour: ${row.hour}`);
      }
      insertHit.run(
        hour.toISOString(),
        requiredInteger(row.path_id, "hit path id", { positive: true }),
        requiredInteger(row.ref_id, "hit referrer id", { positive: true }),
        requiredInteger(row.count, "hit count"),
      );
      hitCount += 1;
    });

    setMetadata.run("last_export_start", replaceFrom);
    if (exportId !== null) setMetadata.run("last_export_id", String(exportId));
    if (finishedAt !== null) setMetadata.run("last_export_finished_at", finishedAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return { pathCount, refCount, hitCount, replaceFrom };
}

export function cachedPeriodStats(database, ranges) {
  const hitStatement = database.prepare(`
    SELECT paths.path, sum(hit_stats.count) AS count
    FROM hit_stats
    JOIN paths USING (path_id)
    WHERE hit_stats.hour >= ? AND hit_stats.hour < ?
    GROUP BY paths.path
    HAVING sum(hit_stats.count) > 0
    ORDER BY paths.path
  `);
  const refStatement = database.prepare(`
    SELECT paths.path, refs.ref AS name, sum(hit_stats.count) AS count
    FROM hit_stats
    JOIN paths USING (path_id)
    JOIN refs USING (ref_id)
    WHERE hit_stats.hour >= ? AND hit_stats.hour < ?
    GROUP BY paths.path, refs.ref
    HAVING sum(hit_stats.count) > 0
    ORDER BY paths.path, refs.ref
  `);

  const hitsByPeriod = {};
  const refsByPeriod = {};
  for (const { key } of PERIOD_DEFINITIONS) {
    const { start, end } = ranges[key];
    hitsByPeriod[key] = hitStatement.all(start, end).map(({ path, count }) => ({
      path,
      count,
    }));
    const refs = new Map();
    for (const { path, name, count } of refStatement.all(start, end)) {
      const pathRefs = refs.get(path) ?? [];
      pathRefs.push({ name, count });
      refs.set(path, pathRefs);
    }
    refsByPeriod[key] = refs;
  }

  return { hitsByPeriod, refsByPeriod };
}
