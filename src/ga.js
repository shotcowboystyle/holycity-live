// GA4 bootstrap for /ga.js. The measurement ID is a Worker secret, so it only exists in production;
// without it the script is empty and nothing is tracked (e.g. under wrangler dev), and the shell shows no banner.
// Opt-in: gtag loads only after the visitor accepts in the cookie banner or turns it on in Settings.
// The choice is localStorage `consent` = {"analytics":"on"|"off","v":1,"at":"<ISO>"}; bump CONSENT_VERSION to ask again.
// settings.html writes the same shape, so keep its version in sync.
export const CONSENT_VERSION = 1;

export function gaScript(id) {
  const headers = { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=3600' };
  if (!/^G-[A-Z0-9]+$/.test(id ?? '')) return new Response('', { headers }); // missing or malformed: never inline it
  return new Response(`{ // block scope: keep locals out of the page's globals
  const V = ${CONSENT_VERSION};
  let loaded = false;
  // 'on' | 'off' | null (not asked yet, or asked under an older version)
  window.analyticsConsent = () => {
    try {
      const c = JSON.parse(localStorage.getItem('consent'));
      if (c?.v === V && (c.analytics === 'on' || c.analytics === 'off')) return c.analytics;
      if (!c && localStorage.getItem('analytics') === 'off') return 'off'; // opted out before the banner existed
    } catch { /* storage blocked or unreadable: treat as not asked, so nothing loads */ }
    return null;
  };
  window.loadGA = () => {
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', '${id}', { send_page_view: false }); // index.html sends one page_view per dashboard tab
    const s = document.createElement('script');
    s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=${id}';
    document.head.append(s);
  };
  window.setAnalyticsConsent = choice => {
    try {
      localStorage.setItem('consent', JSON.stringify({ analytics: choice, v: V, at: new Date().toISOString() }));
      localStorage.removeItem('analytics');
    } catch { /* storage blocked: the choice holds for this visit only */ }
    if (choice === 'on') loadGA();
  };
  if (analyticsConsent() === 'on') loadGA();
}
`, { headers });
}
