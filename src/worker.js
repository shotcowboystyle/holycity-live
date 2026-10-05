// Cloudflare Worker: static files come from ./public (served without invoking this code);
// only /api/* runs here (see run_worker_first in wrangler.jsonc).
import { latestStofs } from './stofs.js';

const CACHE_SECONDS = 1800;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
