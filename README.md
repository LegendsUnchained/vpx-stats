# VPX Stats

Public, half-hourly table-play statistics for the Legends Unchained community.

The site turns anonymous `go-vpx-launcher` play events from GoatCounter into a
static leaderboard. Table IDs are resolved against the latest
[`vpx-standalone-alp4k`](https://github.com/LegendsUnchained/vpx-standalone-alp4k)
release manifest, so the published data includes the table's current display name,
manufacturer, year, and release-tagged `launcher.png` URL.

Once GitHub Pages is enabled, the public endpoints will be:

- Site: `https://vpxstats.legendsunchained.com/`
- Data: `https://vpxstats.legendsunchained.com/data/stats.json`

## How it works

`.github/workflows/pages.yml` runs on pushes to `main` and on demand. Production's
Ash cron dispatches it at minutes 0 and 30 of every hour. The workflow:

1. Downloads the latest ALP4K release manifest.
2. Reads GoatCounter's ranked event paths for rolling day, week, month, year, and
   all-time windows.
3. Reads each played path's referrer totals and groups the leading referrer
   value into HDP (`HA9919`) and 4KP (`HA9920`) cabinet-model counts.
4. Resolves each `vpx-*` path to its manifest metadata and launcher artwork.
5. Writes `site/data/stats.json` and deploys the complete `site/` directory to
   GitHub Pages.

No query starts before the first telemetry event on August 26, 2026. Equal
windows are fetched once, and narrower windows reuse a wider window's referrer
breakdown whenever the table's count is unchanged. Because ranges end on an hour
boundary, the second half-hourly dispatch reuses the published dataset when it
belongs to that same hour.

At a new hour, fixed-start windows also reuse each unchanged table's aggregate
model counts from the previously published JSON. A table is queried again when
its total changes, when its rolling window start moves, or when no valid prior
aggregate exists. Raw referrers are never added to the cache or public contract.

API requests are kept below four per second. The client reads GoatCounter's
`X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`, and `X-Rate-Limit-Reset` headers;
it waits for short resets and stops cleanly on a long exhausted quota so a later
scheduled dispatch can retry without sending requests before the reset. Network
errors, interrupted response bodies, transient 404/408/425 responses, and server
errors use bounded exponential retries with jitter. Retry and terminal messages
include the request URL and underlying transport cause where available.

The generated JSON is a deployment artifact, not a stream of scheduled commits. The
API token is only available to the workflow process and is never included in the
site or its data.

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
      "launcherImage": "https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/v2.0.9/external/vpx-metallicapremium/launcher.png",
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

The existing `counts` and period totals always include every play. `modelCounts`
and each period's `models` summaries include plays whose referrer starts with the
corresponding cabinet model. Plays recorded before model referrers were added, or
with an unrecognized referrer, remain visible under **All** without being guessed
into a model.

The named periods are rolling UTC windows:

- `day`: 24 hours
- `week`: 7 days
- `month`: 30 days
- `year`: 365 days
- `all`: since telemetry began on August 26, 2026

## Table Manager installs

The leaderboard talks directly to the Legends Unchained Table Manager browser
extension. Until the extension returns at least one registered cabinet, install
buttons are not rendered. If any cabinet responds to `/health`, the buttons read
**Install** and open a device chooser when more than one cabinet is registered.
When every registered cabinet is offline, the visible buttons read **Table Manager
Offline** and are disabled.

The page receives only a local connection token, custom name, model, truncated
device ID, and online state. The extension retains each cabinet address and builds
the local Wizard URL itself; the stats site cannot supply an arbitrary URL.

## Repository setup

Before the first workflow run:

1. Add the API token as an Actions repository secret named
   `GOATCOUNTER_API_TOKEN`.
2. In **Settings → Pages**, select **GitHub Actions** as the build and deployment
   source.
3. Run **Refresh stats and deploy Pages** manually to verify the deployment.

The key only needs GoatCounter's statistics-read permission. It does not need
site-read or write access.

## Production schedule

Ash dispatches `pages.yml` through GitHub's `workflow_dispatch` API at minutes 0
and 30. The tracked host files are in `ops/ash/` and are installed as:

- `/usr/local/sbin/vpx-stats-refresh`
- `/etc/cron.d/vpx-stats-refresh`

The GitHub API credential is stored separately in the root-only
`/etc/vpx-stats-refresh/curl.conf`; it is never committed. Each successful or
failed dispatch is written to the system log with the `vpx-stats-refresh` tag.

## Local development

Node.js 20 or newer is required. No packages need to be installed.

```sh
export GOATCOUNTER_API_TOKEN="your-read-only-token"
npm test
npm run fetch -- --force
python3 -m http.server 4173 --directory site
```

Omit `--force` to reuse the current published JSON for the same hour and to reuse
unchanged fixed-window aggregates during a new-hour fetch. Use `--force` when
intentionally validating a completely fresh API run.

Then open `http://localhost:4173/`. `site/data/stats.json` is ignored by Git so a
local live-data run cannot accidentally commit a statistics snapshot.

## Privacy

The launcher submits one anonymous event using the table's `vpx-*` ID after the
cabinet owner opts in. Its referrer contains the cabinet model and launcher
version, such as `HA9920 2.1.0-13`; the published leaderboard aggregates the model
and does not expose individual events. It does not submit a device ID, serial
number, account, license, play duration, IP address, or user agent. This repository
publishes only aggregate per-table counts.
