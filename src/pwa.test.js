import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gaScript } from './ga.js';

const pub = f => new URL(`../public/${f}`, import.meta.url);
const read = f => readFileSync(pub(f), 'utf8');
const sw = read('sw.js');
const list = name => JSON.parse(sw.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1].replace(/'/g, '"'));
const PRECACHE = list('PRECACHE'), CDN = list('CDN');
const fileFor = path => path === '/' ? 'index.html' : /\.\w+$/.test(path) ? path.slice(1) : path.slice(1) + '.html';

// Cloudflare serves /risk for risk.html and redirects /risk.html, and a cached redirect breaks navigations
test('service worker precache lists real files by their served path', () => {
  for (const p of PRECACHE) {
    assert.ok(!p.endsWith('.html'), `${p}: list the extensionless path`);
    assert.ok(existsSync(pub(fileFor(p))), `${p} exists`);
  }
});

// offline only works if every page's local files and CDN libraries are in the lists
test('every asset the pages load is precached', () => {
  const pages = PRECACHE.filter(p => !/\.\w+$/.test(p)).map(fileFor);
  for (const page of pages) {
    const html = read(page);
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"|<link rel="stylesheet" href="([^"]+)"|<img[^>]+src="([^"]+)"/g)) {
      const src = m[1] ?? m[2] ?? m[3];
      if (src === '/ga.js') continue; // Analytics: served by the Worker, pointless offline
      assert.ok(src.startsWith('https://') ? CDN.includes(src) : PRECACHE.includes('/' + src.replace(/^\//, '')), `${page}: ${src}`);
    }
    for (const [, url] of html.matchAll(/"(https:\/\/cdn\.jsdelivr\.net[^"]+\.js)"/g)) assert.ok(CDN.includes(url), `${page}: importmap ${url}`);
  }
  assert.ok(CDN.some(u => u.endsWith('/OrbitControls.js')), 'MapControls imports OrbitControls');
});

test('manifest icons exist and shortcuts open real tabs', () => {
  const m = JSON.parse(read('site.webmanifest')), home = read('index.html');
  for (const i of [...m.icons, ...m.shortcuts.flatMap(s => s.icons)]) assert.ok(existsSync(pub(i.src.slice(1))), i.src);
  assert.ok(m.shortcuts.length >= 1 && m.shortcuts.length <= 4, 'Android shows at most four shortcuts');
  for (const s of m.shortcuts) {
    const tab = s.url.match(/^\/#(\w+)$/)?.[1];
    assert.ok(tab && home.includes(`data-tab="${tab}"`), `${s.name}: ${s.url}`);
  }
  assert.ok(m.icons.every(i => i.purpose !== 'any maskable'), 'one purpose per icon entry');
});

test('analytics script honors the Settings opt-out', () => {
  const js = gaScript('G-TEST1');
  return js.text().then(t => {
    assert.match(t, /localStorage\.getItem\('analytics'\) === 'off'/);
    assert.match(t, /gtag\/js\?id=G-TEST1/);
  }).then(() => gaScript().text()).then(t => assert.equal(t, ''));
});
