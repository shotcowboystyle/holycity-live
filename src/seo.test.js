import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

// every sitemap URL must be a page that names itself as canonical and is linked from the home page
test('sitemap, canonicals and home links agree', () => {
  const locs = [...read('sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  const home = read('index.html');
  for (const loc of locs) {
    const path = new URL(loc).pathname, file = path === '/' ? 'index.html' : path.slice(1) + '.html';
    const html = read(file);
    assert.match(html, new RegExp(`<link rel="canonical" href="${loc}">`), file);
    assert.match(html, /<meta name="description" content="[^"]{50,}">/, file);
    assert.equal(html.match(/<h1[ >]/g)?.length, 1, `${file}: one h1`);
    if (path !== '/') assert.ok(home.includes(`href="${path}"`), `home links ${path}`);
  }
});

// Settings is a page for people, not search engines: linked from home, kept out of the sitemap and marked noindex
test('settings is noindex and off the sitemap', () => {
  assert.match(read('settings.html'), /<meta name="robots" content="noindex">/);
  assert.ok(!read('sitemap.xml').includes('/settings'));
  assert.ok(read('index.html').includes('href="/settings"'));
});
