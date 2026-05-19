# Commute Calc Enricher Design

**Date:** 2026-05-19
**Status:** Approved (brainstorming phase)
**Phase:** post-Phase-C; first enricher plugin shipped by Wabe.

## Goal

Ship the first `Enricher` plugin: `@wabe/enricher-commute`. Given a normalized `Listing`, compute per-target × per-mode commute time using a self-hosted routing stack (OpenRouteService + transitous/Motis + Pelias geocoder), persist the result under `listing.enriched.commute`, and expose a `commute(target, mode)` primitive in the scoring DSL so filters and scorers can consume it.

Also wires the enricher stage into the pipeline (currently loaded but never invoked) and ships a `docker compose` recipe for the routing stack.

## Non-goals

- Live public-transit departures or real-time delay handling (Motis returns timetabled itineraries only).
- Multi-leg fare calculation.
- Isochrone / "max 30min by transit" map view.
- Routing-provider abstraction beyond ORS + Motis (e.g. Google fallback) — single self-hosted stack.
- Time-windows other than a single configured `arrive_by` per target.
- Background re-computation when timetables change (manual `wabe cache clear --commute` + next scan).

## Architecture

Two new packages + pipeline wiring + infra recipe:

- **`plugins/enricher-commute`** (`@wabe/enricher-commute`) — the enricher plugin. Reads `listing.location`, geocodes via Pelias when `coords === null`, computes per-target × per-mode duration via ORS + Motis, writes results under `listing.enriched.commute`, caches in SQLite. Owns its routing-provider adapters internally (no provider abstraction in the SDK — single consumer).
- **`packages/core`** — adds `commute(target, mode)` primitive to the DSL grammar in `packages/core/src/schemas/dsl.ts` and its evaluator. The `enriched.commute` payload stays in the enricher (loose `Record<string, unknown>` in `Listing.enriched`).
- **`packages/server`** — wires the enricher stage into `pipeline.ts` between upsert and the rental-term gate.
- **`packages/db`** — new migration `0003_commute_cache.sql` adding a `commute_cache` table.
- **`docker/commute/`** — `compose.yml` + `README.md` for ORS + Motis + Pelias self-hosting.

## Config

User-facing `commute.yaml` (siblings of `filters.yaml`, `scoring.yaml`):

```yaml
endpoints:
  ors_url: http://localhost:8080/ors
  motis_url: http://localhost:8081
  pelias_url: http://localhost:4000

targets:
  work:
    address: "Brandschenkestrasse 178, 8002 Zürich"
    arrive_by: "08:30"
    weekday: mon
    modes: [transit, cycling, walking]
  partner-work:
    coords: [8.5395, 47.3681]   # skip geocode when user supplies coords
    arrive_by: "09:00"
    weekday: mon
    modes: [transit]

cache:
  enabled: true
  quantize_decimals: 4          # ~11m grid

timeouts:
  geocode_ms: 5000
  route_ms: 15000
```

Top-level `config.yaml`:

```yaml
enabled:
  enrichers:
    - name: enricher-commute
      config_path: ./commute.yaml
```

Zod `CommuteConfig` in the plugin. `targets` must be non-empty. Each target requires `(address | coords)` + `arrive_by` + `weekday` + non-empty `modes`. All three endpoints are required — no public-endpoint fallback.

## Data flow

Per-listing inside `enrich()`:

```
1. coords = listing.location.coords
   if null:
     pelias_geocode(address + postal + city)
       cache hit  → use
       cache miss → POST {pelias_url}/v1/search; take first feature; persist
       still null → return listing unchanged (best-effort)

2. for target in cfg.targets:
     target_coords = target.coords ?? <geocoded once at plugin init>
     for mode in target.modes:
       key = (q(coords), target.id, mode, target.weekday, target.arrive_by_min)
       row = cache.get(key)
       if row && fresh:
         duration_s, distance_m = row
       else:
         if mode == 'transit':
           POST {motis_url}/api/v1/plan { from, to, arriveBy: <next mon 08:30 local> }
           pick fastest itinerary → duration_s
         else:
           profile = { driving:'driving-car', cycling:'cycling-regular', walking:'foot-walking' }[mode]
           POST {ors_url}/v2/directions/{profile} { coordinates:[from,to] }
           → summary.duration, summary.distance
         cache.upsert(key, duration_s, distance_m, now)
       result[target.id][mode] = {
         duration_min: Math.round(duration_s / 60),
         distance_km: distance_m / 1000,
         computed_at,
       }

3. return Listing.parse({ ...listing, enriched: { ...listing.enriched, commute: result } })
```

Concurrency: internal `p-limit(4)` per listing — at most 4 in-flight upstream requests at once. Adequate for self-hosted ORS / Motis.

## Caching

Migration `packages/db/migrations/0003_commute_cache.sql`:

```sql
CREATE TABLE commute_cache (
  from_lat_q   REAL    NOT NULL,
  from_lng_q   REAL    NOT NULL,
  to_target    TEXT    NOT NULL,
  mode         TEXT    NOT NULL,
  weekday      TEXT    NOT NULL,
  arrive_by_min INTEGER NOT NULL,
  duration_s   INTEGER NOT NULL,
  distance_m   INTEGER NOT NULL,
  computed_at  INTEGER NOT NULL,
  PRIMARY KEY (from_lat_q, from_lng_q, to_target, mode, weekday, arrive_by_min)
);
```

- Quantize listing `from` coords to 4 decimals (~11m). Two listings on the same street share a row.
- Target coords resolved once at plugin init, held in memory — no cache row for them.
- `arrive_by_min` = minutes since midnight (0–1439). Different windows do not collide.
- Infinite TTL. Invalidation: new CLI subcommand `wabe cache clear --commute` truncates the table.

Pelias geocode cache: same table family, separate `geocode_cache (address_norm TEXT PRIMARY KEY, lat REAL, lng REAL, computed_at INTEGER)`. `address_norm` = lower-case, collapsed whitespace, trimmed.

## Listing schema & DSL

`Listing.enriched` stays `Record<string, unknown>` — `@wabe/core` doesn't depend on enricher implementations. The plugin exports the typed payload:

```ts
export const CommutePayload = z.record(
  z.string(),
  z.record(
    z.enum(['transit', 'cycling', 'walking', 'driving']),
    z.object({
      duration_min: z.number().int().nonnegative(),
      distance_km: z.number().nonnegative(),
      computed_at: z.coerce.date(),
    })
  )
);
export type CommutePayload = z.infer<typeof CommutePayload>;
```

Written to `listing.enriched.commute`. Scorers and filters that want type-safe access import and parse from `@wabe/enricher-commute`.

DSL primitive `commute(target, mode)` in `packages/core/src/schemas/dsl.ts`:

```yaml
filters:
  - { kind: leq, lhs: { commute: { target: work, mode: transit } }, rhs: 30 }

scoring:
  rules:
    - kind: piecewise
      input: { commute: { target: work, mode: transit } }
      curve: [[0,1.0], [20,0.9], [30,0.6], [45,0.3], [60,0.0]]
      weight: 0.4
    - kind: piecewise
      input: { commute: { target: partner-work, mode: transit } }
      curve: [[0,1.0], [40,0.5], [70,0.0]]
      weight: 0.2
```

Evaluator returns `number` (minutes) or `Infinity` when the target / mode is missing from `enriched.commute`. `leq` filter rejects Infinity; `piecewise` clamps to the last curve value. Matches "best-effort" failure mode.

## Pipeline wiring

`packages/server/src/pipeline.ts` — new stage between upsert and rental-term gate. Existing variable `enriched` (the `Listing.parse(...)` result) renamed to `parsed` to avoid shadowing.

```ts
let current: Listing = parsed;
for (const e of opts.plugins.enrichers) {
  try {
    const before = JSON.stringify(current.enriched);
    current = await e.plugin.enrich(current, {
      logger: log.child({ enricher: e.plugin.name }),
      config: e.config,
      signal: opts.signal,
      db: opts.db,
    });
    if (JSON.stringify(current.enriched) !== before) {
      upsertListing(opts.db, current);
    }
  } catch (err) {
    log.warn({ err, enricher: e.plugin.name, listing_id: current.id }, 'enricher failed; continuing');
  }
}
// rental-term gate, filter, score, notify all read `current` from here on.
```

Enrichers run sequentially in declared order so a future enricher can depend on a prior one. Per-enricher try/catch isolates failures. Re-upsert only when `enriched` actually changed.

## Self-hosted infra

`docker/commute/compose.yml`:

```yaml
services:
  ors:
    image: openrouteservice/openrouteservice:v8.0.0
    ports: ["8080:8080"]
    volumes:
      - ./ors-data:/home/ors/files
      - ./ors-config.yml:/home/ors/ors-config.yml:ro
    environment:
      ORS_CONFIG_LOCATION: /home/ors/ors-config.yml

  motis:
    image: ghcr.io/motis-project/motis:latest
    ports: ["8081:8080"]
    volumes:
      - ./motis-data:/data
    command: ["server", "--config", "/data/config.ini"]

  pelias:
    image: pelias/api:latest
    ports: ["4000:4000"]
    volumes:
      - ./pelias-config.json:/code/pelias.json:ro
    depends_on: [pelias-elasticsearch]

  pelias-elasticsearch:
    image: pelias/elasticsearch:7.16.3
    volumes:
      - ./pelias-es-data:/usr/share/elasticsearch/data
```

`docker/commute/README.md` documents:

- `make data` — download CH OSM extract (geofabrik), SBB GTFS (opentransportdata.swiss), OpenAddresses CH, build Pelias indices (~4GB disk, one-off ~30min).
- `docker compose up -d` — start the three services.
- `make health` — curl each endpoint.
- `make refresh-gtfs` — re-pull SBB GTFS, restart Motis. PT timetables change semi-annually in CH.

No data shipped in-repo. `data/` gitignored.

`wabe doctor` probes `GET {endpoint}/health` for each of the three and reports `[OK]` / `[WARN] commute-ors unreachable`.

## Error handling

- Per-mode failure (ORS / Motis 5xx after retries, no-route): log `warn`, omit from result, continue.
- Per-target geocode failure: log `warn`, omit entire target, continue.
- Listing geocode failure: log `warn`, return listing unchanged (no `enriched.commute` key).
- Upstream 5xx: 2 retries with 500ms / 1500ms exponential backoff via the undici dispatcher used by source plugins. 4xx: no retry; log + skip.
- Timeout per call: `geocode_ms` / `route_ms` from config; `AbortSignal` plumbed through.

No circuit breaker for enrichers in this slice. Add later if observed failure rates warrant.

## Testing

- `plugins/enricher-commute/test/`:
  - `geocode.test.ts` — Pelias adapter against undici MockAgent (hit, miss, multi-feature).
  - `route-ors.test.ts` — car / bike / foot adapter against captured ORS responses.
  - `route-motis.test.ts` — PT adapter; parses Motis itinerary, picks fastest, handles "no route".
  - `cache.test.ts` — quantization, hit / miss, key collision avoidance.
  - `enrich.integration.test.ts` — full `enrich(listing)` flow with mocked HTTP; verifies payload shape, missing-coords path, failure isolation per target.
- `packages/core/test/dsl-commute.test.ts` — grammar + evaluator: `commute(work, transit)` → minutes, missing → Infinity, used inside `leq` filter + `piecewise` scorer.
- `packages/server/test/pipeline-enrich.integration.test.ts` — stub source + stub enricher; asserts the new stage runs, re-upserts only on `enriched` change, failure in one enricher doesn't drop the listing.
- No live HTTP in CI. All endpoints mocked via undici MockAgent. Fixtures captured under `plugins/enricher-commute/test/fixtures/`.

## File map (additions)

| Path | Purpose |
|------|---------|
| `plugins/enricher-commute/package.json` | New package `@wabe/enricher-commute` |
| `plugins/enricher-commute/src/index.ts` | Default export `{ kind:'enricher', plugin }` + `CommuteConfig` |
| `plugins/enricher-commute/src/enrich.ts` | `enrich(listing, ctx)` orchestration |
| `plugins/enricher-commute/src/geocode.ts` | Pelias adapter + cache |
| `plugins/enricher-commute/src/route-ors.ts` | ORS car / bike / foot adapter |
| `plugins/enricher-commute/src/route-motis.ts` | Motis transit adapter |
| `plugins/enricher-commute/src/cache.ts` | Quantize + better-sqlite3 cache adapter |
| `plugins/enricher-commute/src/schemas.ts` | Zod schemas (`CommuteConfig`, `CommutePayload`) |
| `plugins/enricher-commute/test/...` | See Testing |
| `plugins/enricher-commute/README.md` | Plugin docs |
| `packages/core/src/schemas/dsl.ts` | Add `commute(target, mode)` primitive |
| `packages/core/test/dsl-commute.test.ts` | DSL tests |
| `packages/db/migrations/0003_commute_cache.sql` | `commute_cache` + `geocode_cache` tables |
| `packages/server/src/pipeline.ts` | Wire enricher stage |
| `packages/server/test/pipeline-enrich.integration.test.ts` | Pipeline-stage integration test |
| `packages/cli/src/commands/cache.ts` | `wabe cache clear --commute` |
| `docker/commute/compose.yml` | Self-hosted routing stack |
| `docker/commute/README.md` | Setup + maintenance |
| `docker/commute/Makefile` | `make data` / `make health` / `make refresh-gtfs` |
| `examples/zurich-family/commute.yaml` | Example config |
