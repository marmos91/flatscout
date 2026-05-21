# @flatscout/enricher-commute

First-party `Enricher` plugin: computes per-target × per-mode commute time and writes it to `listing.enriched.commute`.

## What it does

For each listing:

1. Resolve listing coordinates — use `location.coords` if present, otherwise geocode `address + postal + city` via Pelias (cached).
2. For each target in `commute.yaml`, for each requested mode (`transit` / `cycling` / `walking` / `driving`), compute travel duration:
   - Transit → Motis (`/api/v1/plan`, arriveBy).
   - Car / bike / foot → ORS (`/v2/directions/{profile}`).
3. Cache results in `commute_cache` (quantized coords + target + mode + weekday + arrive-by). Infinite TTL.
4. Write `enriched.commute[target][mode] = { duration_min, distance_km, computed_at }`.

Failures are best-effort: a failed mode / target is omitted; the listing always proceeds.

## Config (`commute.yaml`)

See `examples/zurich-family/config/commute.yaml`. Minimum:

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
    modes: [transit, cycling]
```

> Coordinates anywhere in this file (`targets[X].coords`) are `[lng, lat]` — the same GeoJSON order Flatscout uses for `Listing.location.coords`. Easy to flip; double-check before running.

## Consuming in filters / scoring

```yaml
# filters.yaml
- {kind: commute, target: work, mode: transit, op: "<=", value: 30, on_missing: pass}

# scoring.yaml
- type: rule
  name: commute-work
  weight: 40
  metric: {kind: commute, target: work, mode: transit}
  normalize: {type: linear, best: 0, worst: 60, invert: true}
  on_missing: zero
```

Missing target / mode evaluates to `Infinity` (filter) / `undefined` (scoring); `linear + invert: true` makes a shorter commute score higher; `on_missing: zero` contributes zero score for absent data.

The `computed_at` field on each cached payload reflects when the listing was last enriched — on cache hits this is the time of the enrich call, not the original computation. Use `flatscout cache clear --commute` if you need to force recomputation (e.g. after a GTFS refresh).

## Self-hosted infra

See `docker/commute/` for the ORS + Motis + Pelias docker-compose recipe.

## Invalidation

`flatscout cache clear --commute` truncates the commute and geocode caches. The next scan repopulates them.
