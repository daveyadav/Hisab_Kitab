/* =========================================================================
 * Hisab — offline app shell (service worker).
 *
 * Makes the app open and work without internet after the first visit.
 * The shell (HTML/CSS/JS/icons) is cached on install; page loads try the
 * network first and fall back to the cache when offline. Records already
 * live in the browser's local storage, so entries work offline too —
 * Google Drive sync simply waits for the connection to return.
 *
 * Bump CACHE below whenever a shelled file changes, so updates reach
 * every device.
 * ========================================================================= */
'use strict';

var CACHE = 'hisab-shell-v16';

/* Files the app cannot boot without. The install FAILS unless every one of
 * these lands in the cache — a worker that "installed" with an empty cache
 * (e.g. the network dropped mid-install) would report ready but never open
 * offline. Failing lets the browser retry the install on the next visit. */
var CRITICAL = ['./', 'index.html', 'css/styles.css', 'js/config.js', 'js/drive.js', 'js/app.js'];
/* One hanging asset must not wedge the worker in "installing" forever. */
var INSTALL_TIMEOUT_MS = 20000;

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var t = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('sw: asset timed out')); }
    }, ms);
    promise.then(function (v) {
      if (!settled) { settled = true; clearTimeout(t); resolve(v); }
    }, function (e) {
      if (!settled) { settled = true; clearTimeout(t); reject(e); }
    });
  });
}

function cacheAll(cache, assets, failLoud) {
  return Promise.all(assets.map(function (a) {
    return withTimeout(cache.add(a), INSTALL_TIMEOUT_MS).then(
      function () { return a; },
      function () { return null; }
    );
  })).then(function (saved) {
    if (!failLoud) return saved;
    var have = {};
    saved.forEach(function (a) { if (a) have[a] = true; });
    var missing = CRITICAL.filter(function (a) { return !have[a]; });
    if (missing.length) throw new Error('sw: critical assets not cached: ' + missing.join(','));
    return saved;
  });
}

var ASSETS = [
  './',
  'index.html',
  'privacy.html',
  'css/styles.css',
  'js/config.js',
  'js/drive.js',
  'js/app.js',
  'manifest.webmanifest',
  'assets/logo.svg',
  'assets/logo-maskable.svg',
  'assets/favicon-32.png',
  'assets/apple-touch-icon.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return cacheAll(c, ASSETS, true); })
      .then(function () { return self.skipWaiting(); })
  );
});

/* Re-fill the cache on demand. If the browser evicted the offline copy
 * (storage pressure), the worker is still installed but cold start fails —
 * the page detects the missing shell and asks for a refill. */
self.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'recache') return;
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return cacheAll(c, ASSETS, false); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys
          .filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  /* Let non-GET and cross-origin requests (Google sign-in, Drive API)
   * pass through untouched. */
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    /* Page loads: network first so updates arrive, cache fallback offline. */
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('index.html');
        });
      })
    );
    return;
  }

  /* Shell assets: cache first, then network. */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
