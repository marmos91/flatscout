# Self-hosted commute routing stack

Three services backing `@wabe/enricher-commute`:

| Service | Host port | Container port | Role |
|---------|-----------|----------------|------|
| ORS     | 8080      | 8082           | Car / bike / foot routing |
| Motis   | 8081      | 8080           | Public-transit routing (Motis 2.x) |
| Pelias  | 4000      | 4000           | Geocoding |

## One-off setup

1. `make data` — downloads CH OSM extract from Geofabrik, the current CH GTFS feed from opentransportdata.swiss, and generates Motis's `config.yml`. Disk: ~4 GB; first-time ~5 min.
2. Copy `ors-config.yml.example` → `ors-config.yml`. Adjust profiles if desired (defaults: car / bike / foot enabled).
3. (Optional) Copy `pelias-config.json.example` → `pelias-config.json` and run the Pelias importers — only needed if you want to geocode listings without coords. See `data-pelias` output for guidance.
4. `make up` — start ORS + Motis (+ Pelias if configured).
5. `make health` — curl each endpoint.

## Memory

ORS holds the CH OSM graph in RAM. The compose file allocates **8 GB heap** (`XMX: 8g`). On hosts with less than 10 GB of free memory, expect OOM during graph build. Either:

- Lower the heap via `XMX` env override and accept slower / less complete profile builds, or
- Build on a beefier host and copy `ors-graphs/` over (persistent volume).

Subsequent `make up` runs skip graph rebuild — the persistent `./ors-graphs/` volume caches the indexed graphs (~1.5 GB on disk).

## Maintenance

- `make refresh-gtfs` — re-pull CH GTFS, regenerate Motis config, restart Motis. CH timetables change semi-annually.
- `make down` / `make logs` — standard compose ops.

## Known gaps

- **Motis 2.x** uses `{ itineraries: [...] }` response shape; `@wabe/enricher-commute`'s `route-motis.ts` parses Motis 1.x's `{ content: { connections: [...] } }`. Transit mode currently returns null at runtime; track in the issue queue.
- **GTFS URL rotates weekly.** The Makefile pins a specific resource; if `make data-gtfs` 404s, fetch the current URL from <https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020> and override via `GTFS_URL=<url> make data-gtfs`.

## Notes

- All data under `./*-data/` and `./ors-graphs/` is gitignored.
- The Wabe daemon expects these endpoints at the URLs in `commute.yaml`. Default ports match this compose file.
- `wabe doctor` probes `/ors/v2/health`, `/`, `/v1/status` respectively; unreachable endpoints surface as `[WARN]` (informational — never fails the doctor exit code).
