import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

test('/api/dem: forwards the query to the 3DEP export once, then serves it from the edge cache', async () => {
  const store = new Map(), upstream = [], pending = [];
  globalThis.caches = { default: {
    match: async k => store.get(k.url)?.clone(),
    put: async (k, r) => { store.set(k.url, r); },
  } };
  globalThis.fetch = async u => { upstream.push(u); return new Response(new Uint8Array([1, 2, 3, 4])); };
  const ctx = { waitUntil: p => pending.push(p) };
  const get = () => worker.fetch(new Request('https://www.holycity.live/api/dem?bbox=1,2,3,4&size=2,2&f=image'), {}, ctx);

  const first = await get(); await Promise.all(pending);
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3, 4]);
  assert.match(first.headers.get('Cache-Control'), /max-age=2592000/);
  assert.deepEqual(upstream, ['https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=1,2,3,4&size=2,2&f=image']);

  const second = await get();
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(upstream.length, 1); // cache hit: 3DEP not asked again
});

test('/api/dem: an upstream error is a 502 and is not cached', async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async k => store.get(k.url), put: async (k, r) => { store.set(k.url, r); } } };
  globalThis.fetch = async () => new Response('busy', { status: 503 });
  const res = await worker.fetch(new Request('https://www.holycity.live/api/dem?x=1'), {}, { waitUntil() {} });
  assert.equal(res.status, 502);
  assert.equal(store.size, 0);
});

test('/api/carta: decodes the Swiftly feed with the key, shares one upstream fetch, and checks input', async () => {
  const store = new Map(), upstream = [], pending = [];
  globalThis.caches = { default: { match: async k => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } } };
  // hand-encoded GTFS-rt: one trip update, trip "t1" on route "12" reaching stop "A" at time 1
  const buf = Uint8Array.from([0x12, 0x15, 0x1a, 0x13, 0x0a, 0x08, 0x0a, 0x02, 0x74, 0x31, 0x2a, 0x02, 0x31, 0x32, 0x12, 0x07, 0x22, 0x01, 0x41, 0x1a, 0x02, 0x10, 0x01]);
  globalThis.fetch = async (u, init) => { upstream.push([u, init.headers.Authorization]); return new Response(buf); };
  const env = { SWIFTLY_KEY: 'k' }, ctx = { waitUntil: p => pending.push(p) };
  const get = path => worker.fetch(new Request(`https://www.holycity.live${path}`), env, ctx);

  const a = await get('/api/carta/stop?id=A'); await Promise.all(pending);
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), [{ trip: 't1', route: '12', time: 1, delay: null, skipped: false }]);
  assert.match(a.headers.get('Cache-Control'), /max-age=15/);
  assert.deepEqual(upstream, [['https://api.goswift.ly/real-time/bcdcog/gtfs-rt-trip-updates', 'k']]);
  await get('/api/carta/stop?id=B'); await Promise.all(pending);
  assert.equal(upstream.length, 1); // another stop reuses the cached feed

  assert.equal((await get('/api/carta/stop?id=../x')).status, 400);
  assert.equal((await get('/api/carta/stop')).status, 400);
  assert.equal((await get('/api/carta/nope')).status, 404);
  assert.equal((await worker.fetch(new Request('https://www.holycity.live/api/carta/vehicles'), {}, ctx)).status, 503);
});

test('/api/carta: an upstream error is a 502 and is not cached', async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async k => store.get(k.url), put: async (k, r) => { store.set(k.url, r); } } };
  globalThis.fetch = async () => new Response('nope', { status: 401 });
  const res = await worker.fetch(new Request('https://www.holycity.live/api/carta/vehicles'), { SWIFTLY_KEY: 'k' }, { waitUntil() {} });
  assert.equal(res.status, 502);
  assert.equal(store.size, 0);
});
