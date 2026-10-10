// GA4 bootstrap for /ga.js. The measurement ID is a Worker secret, so it only exists in production;
// without it the script is empty and nothing is tracked (e.g. under wrangler dev).
// Visitors can opt out in Settings (localStorage analytics=off): then gtag is never loaded.
export function gaScript(id) {
  const headers = { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=3600' };
  if (!/^G-[A-Z0-9]+$/.test(id ?? '')) return new Response('', { headers }); // missing or malformed: never inline it
  return new Response(`{ // block scope: keep locals out of the page's globals
  let off = false;
  try { off = localStorage.getItem('analytics') === 'off'; } catch { /* storage blocked: track as usual */ }
  if (!off) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', '${id}', { send_page_view: false }); // index.html sends one page_view per dashboard tab
    const s = document.createElement('script');
    s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=${id}';
    document.head.append(s);
  }
}
`, { headers });
}
