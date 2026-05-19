CREATE TABLE commute_cache (
  from_lat_q     REAL    NOT NULL,
  from_lng_q     REAL    NOT NULL,
  to_target      TEXT    NOT NULL,
  mode           TEXT    NOT NULL,
  weekday        TEXT    NOT NULL,
  arrive_by_min  INTEGER NOT NULL,
  duration_s     INTEGER NOT NULL,
  distance_m     INTEGER NOT NULL,
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (from_lat_q, from_lng_q, to_target, mode, weekday, arrive_by_min)
);

CREATE TABLE geocode_cache (
  address_norm TEXT PRIMARY KEY,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  computed_at  INTEGER NOT NULL
);
