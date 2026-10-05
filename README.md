# Holy City Live

Live civic dashboards for Charleston, SC — [holycity.live](https://holycity.live)

| Tab | What it shows |
| --- | --- |
| **Flood & Heat Risk** | 3D Three.js map: tidal + storm-surge flooding, rain ponding (radar + forecast, compounding with tide), heat index with City heat-island data, FEMA zones, sea level rise scenarios, stormwater, tree canopy, air quality, NWS alerts |
| **Construction Near Me** | City permits, road closures and open code cases around an address |
| **Public Safety Trends** | CPD arrests and field contacts — trends, charges, patrol teams — over a neighborhood equity map |
| **Service Days** | Trash, yard waste and street sweeping days, fire station, representatives, zoning, flood zone, nearby parks |

## Run

```bash
python3 server.py        # http://localhost:8765
python3 server.py --selftest
```

No build step and no API keys. `server.py` serves the static files and proxies NOAA STOFS surge guidance
(`/api/stofs`), which is published on S3 without CORS headers. Three.js and Leaflet load from CDNs.

## Data sources

All public, fetched live in the browser:

- **NOAA** — CO-OPS tide gauge 8665530 (observed, predictions, datums, flood stages, 2022 sea level rise scenarios),
  NWS Water Prediction Service official harbor forecast, STOFS-2D-Global surge guidance, MRMS radar rainfall, NWS alerts
- **USGS** — 3DEP elevation
- **FEMA** — National Flood Hazard Layer
- **Open-Meteo** — weather forecast and CAMS air quality
- **City of Charleston GIS** — permits, code cases, road closures, police open data, heat-island models, tree canopy,
  equity, storm inlets and pipes, service areas, districts, geocoder
- **Charleston County GIS** — storm pipes
- **Census TIGERweb** — ZIP extents · **Esri** — basemaps

## Caveats

- Flooding is a bathtub + depression-fill model, not hydraulic routing. Rain-model defaults were fit to one event
  (12 of 15 City flood closures on Oct 4, 2026).
- Arrests and stops measure police activity, not crime, and are located where they happened.
- City data covers City of Charleston limits; outside them, results are partial.
