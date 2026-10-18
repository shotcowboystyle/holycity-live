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
