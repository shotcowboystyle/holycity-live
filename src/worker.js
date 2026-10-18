// Cloudflare Worker: static files come from ./public (served without invoking this code);
// only /api/* and /ga.js run here (see run_worker_first in wrangler.jsonc).
// /api/dem: USGS 3DEP elevation export for the Flood & Heat map. The server renders it in ~10 s, but elevation doesn't
// change, so the edge keeps each export (one per query string; the page always asks for the same one) for 30 days.
import { latestStofs } from './stofs.js';
import { gaScript } from './ga.js';

const CACHE_SECONDS = 1800;
const DEM = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const DEM_SECONDS = 30 * 86400;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/ga.js') return gaScript(env.GA_MEASUREMENT_ID);
    if (url.pathname === '/api/dem') return dem(url, ctx);
    if (url.pathname !== '/api/stofs') return env.ASSETS.fetch(request);

    const key = new Request(url.origin + url.pathname); // ignore query strings so every visitor shares one entry
    const hit = await caches.default.match(key);
    if (hit) return hit;
    try {
      const res = Response.json(await latestStofs(), { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
      ctx.waitUntil(caches.default.put(key, res.clone()));
      return res;
    } catch (e) { // the page shows this in its Data sources panel and falls back to tide predictions
      console.error('stofs', e);
      return Response.json({ error: String(e.message ?? e) }, { status: 502 });
    }
  },
};

async function dem(url, ctx) {
  const key = new Request(url.origin + url.pathname + url.search);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const r = await fetch(DEM + url.search); // only ever this one endpoint: the query picks the area and size
  if (!r.ok) return new Response(`${r.status} 3DEP export`, { status: 502 }); // the page shows it in Data sources
  const res = new Response(r.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': `public, max-age=${DEM_SECONDS}` } });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}
