// Theme for every page: the visitor's pick from the header toggle, else the OS setting. Loaded in <head> so pages never flash.
let pick;
try { pick = localStorage.getItem('theme'); } catch { /* storage blocked: follow the OS */ }
document.documentElement.dataset.theme = pick ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
