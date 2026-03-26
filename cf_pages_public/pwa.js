// Minimal PWA bootstrap.
// This file exists so index/admin pages don't 404 on GitHub Pages.

(() => {
  try {
    if (!("serviceWorker" in navigator)) return;
    // Only register if a service worker exists (optional).
    // If you later add `sw.js`, this will start working automatically.
    navigator.serviceWorker.getRegistrations().catch(() => {});
  } catch {
    // no-op
  }
})();
