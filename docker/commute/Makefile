.PHONY: data data-osm data-gtfs data-pelias up down logs health refresh-gtfs

OSM_URL = https://download.geofabrik.de/europe/switzerland-latest.osm.pbf
# CH GTFS feed; resource URL rotates weekly — check
# https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020 for the current ZIP.
GTFS_URL ?= https://data.opentransportdata.swiss/dataset/3d2c18f9-9ef1-463f-a249-5c67604efd74/resource/e9d3bca5-ba60-45b0-a027-0855de6be667/download/gtfs_fp2026_20260516.zip

data: data-osm data-gtfs motis-config data-pelias

data-osm:
	mkdir -p ors-data motis-data
	curl -L -o ors-data/switzerland-latest.osm.pbf $(OSM_URL)
	cp ors-data/switzerland-latest.osm.pbf motis-data/

data-gtfs:
	mkdir -p motis-data
	curl -L -o motis-data/gtfs.zip $(GTFS_URL)

motis-config:
	# Motis 2.x: generate config.yml from inputs in /data. One-off step.
	docker run --rm -v $(PWD)/motis-data:/data -w /data --entrypoint /motis \
		ghcr.io/motis-project/motis:latest config gtfs.zip switzerland-latest.osm.pbf

data-pelias:
	@echo "Pelias indexing: run the standard pelias importers against your ES instance."
	@echo "See https://github.com/pelias/docker for the openaddresses + OSM + WhosOnFirst flow."

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

health:
	@curl -fsS http://localhost:8080/ors/v2/health && echo " ORS ok"
	@curl -fsS http://localhost:8081/ || echo " Motis down"
	@curl -fsS http://localhost:4000/v1/status || echo " Pelias down"

refresh-gtfs: data-gtfs
	docker compose restart motis
