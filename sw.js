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

var CACHE = 'hisab-shell-v7';

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
      .then(function (c) {
        /* Cache each asset on its own: one missing file must not kill
         * the whole offline install. */
        return Promise.all(ASSETS.map(function (a) {
          return c.add(a).catch(function () { /* keep going */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
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
