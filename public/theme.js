// Theme for every page: the visitor's pick from Settings, else the OS setting. Loaded in <head> so pages never flash.
// applyTheme() is global so the shell and the Settings page can re-apply after the pick changes.
function applyTheme() {
  let pick;
  try { pick = localStorage.getItem('theme'); } catch { /* storage blocked: follow the OS */ }
  document.documentElement.dataset.theme = pick ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
applyTheme();
