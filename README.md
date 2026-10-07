# Holy City Live

Live civic dashboards for Charleston, SC — [holycity.live](https://holycity.live)

| Tab | What it shows |
| --- | --- |
| **Flood & Heat Risk** | 3D Three.js map with a plain-language ride check: where water is on the streets and when, a 48-hour strip of hourly harbor levels lit up when flooding hits, and three toggles (closed streets, heat, satellite). Under **More**: tidal + storm-surge flooding vs rain ponding, sea level rise and surge what-ifs, rain-model calibration, FEMA zones, stormwater, tree canopy, harbor chart, air quality, NWS alerts |
| **Construction Near Me** | What's closed and what's being built around an address: closures first, the biggest projects, a 12-month permit strip, and ¼ / ½ / 1 mile. Under **More**: permit categories, full lists, code cases, older permits |
| **Public Safety Trends** | Police activity in your neighborhood in plain words (per resident, compared with the rest of the city) and the citywide trend, over a 24-month strip. Under **More**: equity shading, charges, patrol teams |
| **Service Days** | When the trash goes out, yard waste and street sweeping, on a two-week calendar strip. Under **More**: fire station, representatives, zoning, flood zone, nearby parks |

## Run

```bash
npm install
npm run dev      # http://localhost:8765 (wrangler dev: static files + the STOFS proxy)
npm test         # STOFS parser + plain-language wording tests
npm run deploy   # Cloudflare Workers
```

No build step and no API keys. The site is plain HTML/JS in `public/`, served as Cloudflare Workers static assets.
`src/worker.js` runs only for `/api/stofs`: it proxies NOAA STOFS surge guidance (published on S3 without CORS
headers) and caches the parsed result at the edge for 30 minutes. Three.js and Leaflet load from CDNs.

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

## License

[MIT](LICENSE)
