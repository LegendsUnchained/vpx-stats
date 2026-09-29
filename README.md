# VPX Stats

Public, hourly table-play statistics for the Legends Unchained community.

The site turns anonymous `go-vpx-launcher` play events from GoatCounter into a
static leaderboard. Table IDs are resolved against the latest
[`vpx-standalone-alp4k`](https://github.com/LegendsUnchained/vpx-standalone-alp4k)
release manifest, so the published data includes the table's current display name,
manufacturer, year, and box art. The art URL points at that repo's `manifest`
branch — a WebP re-encode of each table's `launcher.png` (~88% smaller, no
per-release staleness — see `launcherImageUrl` in `scripts/stats-lib.mjs`),
not a release-tagged raw file.

Once GitHub Pages is enabled, the public endpoints will be:

- Site: `https://vpxstats.legendsunchained.com/`
- Data: `https://vpxstats.legendsunchained.com/data/stats.json`
- Totals: `https://vpxstats.legendsunchained.com/data/totals.json`

## How it works

A scheduled worker generates the data at minute 7 of every hour:

1. Requests one background GoatCounter JSON export and polls until it is ready.
2. Downloads its hourly path/referrer aggregates and transactionally replaces an
   overlapping range in a persistent SQLite cache.
3. Builds rolling day, week, month, year, and all-time counts locally, including
   HDP (`HA9919`) and 4KP (`HA9920`) cabinet-model totals.
4. Resolves table metadata and artwork from the latest ALP4K release manifest.
5. Pushes `stats.json` to the `data` branch and dispatches the Pages workflow.

The first export starts on August 26, 2026. Later exports start one UTC day before
the latest cached hour, so their size stays bounded while the overlap captures
late aggregate changes. SQLite replaces that entire overlap in one transaction;
failed or repeated runs cannot double-count it. Periods use completed UTC-hour
boundaries because GoatCounter's retained export data is hourly.

The export client reads GoatCounter's `X-Rate-Limit-Limit`,
`X-Rate-Limit-Remaining`, `X-Rate-Limit-Reset`, and `Retry-After` headers. It
waits for short resets and exits cleanly on an hourly reset so the next cron run
can retry. Transient network and server failures use bounded retries.

GitHub Actions never calls GoatCounter. On a worker dispatch, it checks out `main`
and the generated `data` branch, validates `stats.json`, and deploys the static
site. A push to `main` additionally runs the compiler tests before deploying.
The GoatCounter API token exists only in the worker's private environment and
is never included in the repository, Actions, site, or public data.

## Data contract

`stats.json` is versioned and keyed by the stable table folder ID used by both the
launcher and Table Manager:

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-08-28T20:17:09.241Z",
  "modelDefinitions": [
    { "key": "HA9919", "label": "HDP" },
    { "key": "HA9920", "label": "4KP" }
  ],
  "source": {
    "manifestRelease": "v2.0.9"
  },
  "periods": {
    "month": {
      "label": "Last 30 days",
      "start": "2026-08-26T00:00:00.000Z",
      "end": "2026-08-28T20:00:00.000Z",
      "totalPlays": 5,
      "activeTables": 5,
      "unmatchedPlays": 1,
      "models": {
        "HA9919": { "totalPlays": 2, "activeTables": 2, "unmatchedPlays": 0 },
        "HA9920": { "totalPlays": 3, "activeTables": 3, "unmatchedPlays": 1 }
      }
    }
  },
  "tables": {
    "vpx-metallicapremium": {
      "name": "Metallica (Premium Monsters) (Stern 2013)",
      "manufacturer": "Stern",
      "year": 2013,
      "nsfw": false,
      "launcherImage": "https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/manifest/boxart/vpx-metallicapremium.webp",
      "counts": {
        "day": 1,
        "week": 1,
        "month": 1,
        "year": 1,
        "all": 1
      },
      "modelCounts": {
        "HA9919": { "day": 0, "week": 0, "month": 0, "year": 0, "all": 0 },
        "HA9920": { "day": 1, "week": 1, "month": 1, "year": 1, "all": 1 }
      }
    }
  }
}
```

Every table in the release manifest is present, including tables with zero plays.
`unmatchedPlays` counts events whose path is not in the latest manifest; these are
not given a misleading display name or added to the table map.

The existing table `counts` and matched period totals include every play for
current-manifest tables. `modelCounts`
and each period's `models` summaries include plays whose referrer starts with the
corresponding cabinet model. Plays recorded before model referrers were added, or
with an unrecognized referrer, remain visible under **All** without being guessed
into a model.

### `totals.json`

The headline numbers on their own, for callers that want a period total and none
of the per-table detail — `stats.json` is ~220 KB of tables and artwork URLs, and
the [Table Manager site](https://vpxtablemanager.com) pulls two numbers out of it
on every visit.

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-09-09T05:07:04.679Z",
  "tableCount": 306,
  "periods": {
    "day":   { "label": "Last 24 hours", "start": "…", "end": "…", "totalPlays": 439,  "activeTables": 134 },
    "week":  { "label": "Last 7 days",   "start": "…", "end": "…", "totalPlays": 3253, "activeTables": 271 },
    "month": { "label": "Last 30 days",  "start": "…", "end": "…", "totalPlays": 4730, "activeTables": 293 },
    "year":  { "label": "Last 365 days", "start": "…", "end": "…", "totalPlays": 4730, "activeTables": 293 },
    "all":   { "label": "All time",      "start": "…", "end": "…", "totalPlays": 4730, "activeTables": 293 }
  }
}
```

It is derived from `stats.json` during the Pages deploy rather than generated by
the worker: same source, same run, so the two cannot report different numbers,
and the refresh worker keeps publishing one artifact. `totalPlays` is the
matched-play count the site itself displays; unmatched plays stay in
`stats.json`.

The named periods are rolling UTC windows:

- `day`: 24 hours
- `week`: 7 days
- `month`: 30 days
- `year`: 365 days
- `all`: since telemetry began on August 26, 2026

## Repository setup

GitHub Pages uses **GitHub Actions** as its build and deployment source. The
`data` branch contains the latest generated `stats.json`; `main` contains the
site and compiler. No GoatCounter secret is required in GitHub Actions.

## Local development

Node.js 22 or newer and `unzip` are required. No npm packages need to be
installed.

```sh
export GOATCOUNTER_API_TOKEN="your-read-only-token"
npm test
npm run fetch:export -- --state-dir .cache/export
python3 -m http.server 4173 --directory site
```

The export endpoint allows one new export per hour. Reusing the same state
directory makes later runs request only the overlap needed to update the cache.

Then open `http://localhost:4173/`. `site/data/stats.json` is ignored by Git so a
local live-data run cannot accidentally commit a statistics snapshot.

## Privacy

After the cabinet owner opts in, each table launch submits at least one anonymous
event using the table's `vpx-*` ID. When the launcher receives verified completed-
game data, it submits that accurate count instead; otherwise the launch counts as
one play so tables without a supported memory map are still represented. The
event referrer contains the cabinet model and launcher version, such as
`HA9920 2.1.0-13`; the published leaderboard aggregates the model and does not
expose individual events. It does not submit a device ID, serial number, account,
license, play duration, IP address, or user agent. This repository publishes only
aggregate per-table counts.
