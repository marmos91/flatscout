.PHONY: data data-osm data-gtfs data-pelias up down logs health refresh-gtfs

OSM_URL = https://download.geofabrik.de/europe/switzerland-latest.osm.pbf
GTFS_URL = https://opentransportdata.swiss/dataset/timetable-gtfs.zip

data: data-osm data-gtfs data-pelias

data-osm:
	mkdir -p ors-data motis-data
	curl -L -o ors-data/switzerland-latest.osm.pbf $(OSM_URL)
	cp ors-data/switzerland-latest.osm.pbf motis-data/

data-gtfs:
	mkdir -p motis-data
	curl -L -o motis-data/gtfs.zip $(GTFS_URL)

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
	@curl -fsS http://localhost:8081/ && echo " Motis ok"
	@curl -fsS http://localhost:4000/v1/status && echo " Pelias ok"

refresh-gtfs: data-gtfs
	docker compose restart motis
