// GA4 bootstrap for /ga.js. The measurement ID is a Worker secret, so it only exists in production;
// without it the script is empty and nothing is tracked (e.g. under wrangler dev).
export function gaScript(id) {
  const headers = { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=3600' };
  if (!/^G-[A-Z0-9]+$/.test(id ?? '')) return new Response('', { headers }); // missing or malformed: never inline it
  return new Response(`window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', '${id}', { send_page_view: false }); // index.html sends one page_view per dashboard tab
{ // block scope: keep s out of the page's globals
  const s = document.createElement('script');
  s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=${id}';
  document.head.append(s);
}
`, { headers });
}
