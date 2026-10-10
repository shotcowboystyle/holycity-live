// Service worker: the app shell is kept for offline use; CDN libraries and fonts are kept forever (versioned URLs);
// live data and map tiles are kept as a fallback for when the network is gone. No version to bump: same-origin
// files are network-first, so a deploy shows up on the next online load and the cache only serves offline.
const SHELL = 'hcl-shell', RUNTIME = 'hcl-runtime', RUNTIME_MAX = 3000;
const PRECACHE = ['/', '/risk', '/construction', '/safety', '/services', '/about', '/settings',
  '/tokens.css', '/dash.css', '/page.css', '/theme.js', '/dash.js', '/say.js', '/ride.js', '/app.js',
  '/logo-reverse.svg', '/logo-color.svg', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/site.webmanifest'];
const CDN = ['https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/MapControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;800&display=swap',
  'https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400..700&family=Public+Sans:wght@400;600;800&display=swap'];
const STATIC_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const OFFLINE_FRAME = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui;background:#141A22;color:#F6F4EE">This dashboard hasn\'t been saved for offline use yet. Open it once while online.';

// only complete, same-type-as-requested responses are kept: opaque ones can't be reused and cost ~7 MB of quota each
const keep = r => r && r.ok && r.type !== 'opaque' && !r.redirected; // a cached redirect can't be served to a navigation
async function trim(name, max) { // ponytail: count cap, not LRU; cache.keys() is insertion order
  const c = await caches.open(name), keys = await c.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => c.delete(k)));
}

async function precache() {
  const shell = await caches.open(SHELL), run = await caches.open(RUNTIME);
  await shell.addAll(PRECACHE);
  // one CDN hiccup shouldn't fail the install: whatever is missing is fetched (and kept) on first use
  await Promise.allSettled(CDN.map(u => fetch(u, { mode: 'cors' }).then(r => { if (keep(r)) return run.put(u, r); })));
}
self.addEventListener('install', e => e.waitUntil(precache()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL && k !== RUNTIME) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'precache') e.waitUntil(precache()); // Settings switched the offline copy back on: the caches were emptied, this worker was kept
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || !url.protocol.startsWith('http')) return;
  if (url.origin === location.origin) return e.respondWith(sameOrigin(req, url));
  if (STATIC_HOSTS.includes(url.host)) return e.respondWith(cacheFirst(req));
  e.respondWith(networkFirst(req));
});

async function sameOrigin(req, url) {
  const key = url.origin + url.pathname; // the shell's query string (?at=…) is state, not a different page
  try {
    const r = await fetch(req);
    if (keep(r) && url.pathname !== '/ga.js') { const c = await caches.open(SHELL); c.put(key, r.clone()); }
    return r;
  } catch (err) {
    const hit = await caches.match(key);
    if (hit) return hit;
    if (req.destination === 'document') return (await caches.match('/')) ?? Response.error();
    if (req.destination === 'iframe') return new Response(OFFLINE_FRAME, { headers: { 'Content-Type': 'text/html' } });
    throw err;
  }
}
async function cacheFirst(req) {
  const hit = await caches.match(req.url);
  if (hit) return hit;
  const r = await fetch(new Request(req.url, { mode: 'cors' })); // a cors response also serves later no-cors <script>/<link> loads
  if (keep(r)) { const c = await caches.open(RUNTIME); c.put(req.url, r.clone()); }
  return r;
}
let puts = 0;
async function networkFirst(req) {
  try {
    const r = await fetch(req);
    if (keep(r)) { const c = await caches.open(RUNTIME); await c.put(req.url, r.clone()); if (++puts % 50 === 0) await trim(RUNTIME, RUNTIME_MAX); }
    return r;
  } catch (err) {
    return (await caches.match(req.url)) ?? Promise.reject(err);
  }
}
