# Self-hosted commute routing stack

Three services backing `@wabe/enricher-commute`:

| Service | Port | Role |
|---------|------|------|
| ORS     | 8080 | Car / bike / foot routing |
| Motis   | 8081 | Public-transit routing (transitous-compatible) |
| Pelias  | 4000 | Geocoding |

## One-off setup

1. `make data` — downloads CH OSM extract from Geofabrik and SBB GTFS from opentransportdata.swiss into `./ors-data/` and `./motis-data/`. Disk: ~4 GB.
2. Copy `ors-config.yml.example` → `ors-config.yml`. Adjust profiles if desired (defaults: car / bike / foot enabled).
3. Copy `pelias-config.json.example` → `pelias-config.json`. Run the Pelias importers (one-off — see `data-pelias` target output for guidance).
4. `make up` — start all three.
5. `make health` — curl each endpoint.

## Maintenance

- `make refresh-gtfs` — re-pull SBB GTFS and restart Motis. CH timetables change semi-annually.
- `make down` / `make logs` — standard compose ops.

## Notes

- All data under `./*-data/` is gitignored.
- The Wabe daemon expects these endpoints at the URLs in `commute.yaml`. Pair-default values match this compose file.
- `wabe doctor` probes `/v2/health`, `/`, `/v1/status` respectively.
