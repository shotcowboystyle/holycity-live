// Cloudflare Worker: static files come from ./public (served without invoking this code);
// only /api/* and /ga.js run here (see run_worker_first in wrangler.jsonc).
// /api/dem: USGS 3DEP elevation export for the Flood & Heat map. The server renders it in ~10 s, but elevation doesn't
// change, so the edge keeps each export (one per query string; the page always asks for the same one) for 30 days.
// /api/carta/{vehicles,stop,alerts}: CARTA live buses from Swiftly (key in the SWIFTLY_KEY secret; no CORS upstream).
import { latestStofs } from './stofs.js';
import { gaScript } from './ga.js';
import { vehicles, arrivals, alerts } from './gtfsrt.js';

const CACHE_SECONDS = 1800;
const DEM = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const DEM_SECONDS = 30 * 86400;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/ga.js') return gaScript(env.GA_MEASUREMENT_ID);
    if (url.pathname === '/api/dem') return dem(url, ctx);
    if (url.pathname.startsWith('/api/carta/')) return carta(url, env, ctx);
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

// Each Swiftly GTFS-rt feed is fetched at most once per FEED_SECONDS per edge location and decoded to the few fields the
// Transit tab draws. /api/carta/stop?id=… filters the trip-updates feed to one stop.
const SWIFTLY = 'https://api.goswift.ly/real-time/bcdcog';
const LIVE = { vehicles: ['gtfs-rt-vehicle-positions', vehicles], stop: ['gtfs-rt-trip-updates', arrivals], alerts: ['gtfs-rt-alerts', alerts] };
const FEED_SECONDS = 15;

async function carta(url, env, ctx) {
  const kind = url.pathname.slice('/api/carta/'.length), live = LIVE[kind], stop = url.searchParams.get('id');
  if (!live) return Response.json({ error: 'not found' }, { status: 404 });
  if (kind === 'stop' && !/^[\w-]{1,32}$/.test(stop ?? '')) return Response.json({ error: 'stop id required' }, { status: 400 });
  if (!env.SWIFTLY_KEY) return Response.json({ error: 'live data not configured' }, { status: 503 }); // the page falls back to the schedule
  const key = new Request(url.origin + url.pathname + (kind === 'stop' ? `?id=${stop}` : ''));
  const hit = await caches.default.match(key);
  if (hit) return hit;
  try {
    const feed = await swiftly(live[0], url.origin, env.SWIFTLY_KEY, ctx);
    const res = Response.json(kind === 'stop' ? live[1](feed, stop) : live[1](feed), { headers: { 'Cache-Control': `public, max-age=${FEED_SECONDS}` } });
    ctx.waitUntil(caches.default.put(key, res.clone()));
    return res;
  } catch (e) { // the page says live times are unavailable and keeps showing the schedule
    console.error('carta', e);
    return Response.json({ error: String(e.message ?? e) }, { status: 502 });
  }
}

async function swiftly(feed, origin, apiKey, ctx) { // raw protobuf, shared by every stop's request; never served to visitors
  const key = new Request(`${origin}/api/carta/_feed/${feed}`), hit = await caches.default.match(key);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const r = await fetch(`${SWIFTLY}/${feed}`, { headers: { Authorization: apiKey } });
  if (!r.ok) throw new Error(`${r.status} Swiftly ${feed}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  ctx.waitUntil(caches.default.put(key, new Response(buf, { headers: { 'Cache-Control': `public, max-age=${FEED_SECONDS}` } })));
  return buf;
}
