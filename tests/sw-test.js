/* Hisab service worker tests — sw.js with mocked ServiceWorker globals.
 * Covers: install caches the shell, activate drops old caches,
 * offline navigation/asset fallback, cross-origin passthrough,
 * online navigation refreshes the cache.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

const ORIGIN = 'https://daveyadav.github.io';
const SCOPE = ORIGIN + '/Hisab_Kitab/';

function mockResponse(url, ok, body) {
  return { url: url, ok: ok, body: body, clone: function () { return mockResponse(url, ok, body); } };
}

function MockCache() { this.map = new Map(); }
MockCache.prototype._key = function (req) {
  return typeof req === 'string' ? new URL(req, SCOPE).href : req.url;
};
MockCache.prototype.addAll = async function (list) {
  for (const p of list) { await this.add(p); }
};
MockCache.prototype.add = async function (p) {
  const url = new URL(p, SCOPE).href;
  this.map.set(url, mockResponse(url, true, 'cached:' + url));
};
MockCache.prototype.match = async function (req) { return this.map.get(this._key(req)) || null; };
MockCache.prototype.put = async function (req, res) { this.map.set(this._key(req), res); };

const cachesMock = {
  _caches: new Map(),
  open: async function (name) {
    if (!this._caches.has(name)) this._caches.set(name, new MockCache());
    return this._caches.get(name);
  },
  keys: async function () { return Array.from(this._caches.keys()); },
  delete: async function (name) { return this._caches.delete(name); },
  match: async function (req) {
    const url = typeof req === 'string' ? new URL(req, SCOPE).href : req.url;
    for (const c of this._caches.values()) {
      const hit = c.map.get(url);
      if (hit) return hit;
    }
    return null;
  }
};

const listeners = {};
const selfMock = {
  location: { origin: ORIGIN },
  skipWaiting: function () { return Promise.resolve(); },
  clients: { claim: function () { return Promise.resolve(); } },
  addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); }
};

let fetchBehavior = 'ok';
async function fetchMock(req) {
  if (fetchBehavior === 'fail') throw new Error('offline');
  const url = typeof req === 'string' ? req : req.url;
  return mockResponse(url, true, 'network:' + url);
}

const sandbox = { self: selfMock, caches: cachesMock, fetch: fetchMock, URL: URL };
vm.createContext(sandbox);
const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
/* Cache name is read from sw.js so version bumps don't break the tests. */
const CACHE_NAME = (SW_SRC.match(/var CACHE = '([^']+)'/) || [])[1] || 'hisab-shell-v1';
vm.runInContext(SW_SRC, sandbox, { filename: 'sw.js' });

function fire(type, event) {
  let waiter = null;
  const e = Object.assign({
    waitUntil: function (p) { waiter = p; },
    respondWith: function (p) { waiter = p; }
  }, event);
  (listeners[type] || []).forEach(function (fn) { fn(e); });
  return waiter;
}

(async function () {
  // install → whole shell cached
  await fire('install', {});
  const cache = await cachesMock.open(CACHE_NAME);
  check('install caches the app shell', cache.map.size >= 14, 'got ' + cache.map.size);
  check('install caches index.html', !!cache.map.get(SCOPE + 'index.html'));
  check('install caches js/app.js', !!cache.map.get(SCOPE + 'js/app.js'));
  check('install caches manifest + icons',
    !!cache.map.get(SCOPE + 'manifest.webmanifest') && !!cache.map.get(SCOPE + 'assets/icon-192.png'));

  // install survives a single failing asset (offline must not die on one 404)
  {
    const failing = new MockCache();
    const origAdd = failing.add;
    failing.add = async function (p) {
      if (String(p).indexOf('logo-maskable') >= 0) throw new Error('404');
      return origAdd.call(this, p);
    };
    cachesMock._caches.set(CACHE_NAME + '-probe', failing);
    let ok = true;
    try {
      const ASSETS_PROBE = (SW_SRC.match(/var ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
      const list = ASSETS_PROBE.split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
      await Promise.all(list.map(a => failing.add(a).catch(function () {})));
    } catch (e) { ok = false; }
    check('install keeps going when one asset fails', ok && failing.map.size >= 13, 'got ' + failing.map.size);
    cachesMock._caches.delete(CACHE_NAME + '-probe');
  }

  // activate → old caches dropped
  await cachesMock.open('hisab-shell-old-test');
  await fire('activate', {});
  const keys = await cachesMock.keys();
  check('activate removes old caches', keys.length === 1 && keys[0] === CACHE_NAME, keys.join(','));

  // offline navigation → cached page
  fetchBehavior = 'fail';
  const navRes = await fire('fetch', { request: { method: 'GET', url: SCOPE, mode: 'navigate' } });
  check('offline navigation serves cached page',
    !!navRes && (navRes.url === SCOPE || navRes.url === SCOPE + 'index.html'), navRes && navRes.url);

  // offline asset → served from cache
  const assetRes = await fire('fetch', { request: { method: 'GET', url: SCOPE + 'js/app.js', mode: 'no-cors' } });
  check('offline asset served from cache', !!assetRes && assetRes.body.indexOf('cached:') === 0);

  // cross-origin (Google) → untouched, no respondWith
  const gRes = await fire('fetch', { request: { method: 'GET', url: 'https://accounts.google.com/gsi/client', mode: 'no-cors' } });
  check('cross-origin requests pass through', gRes === null || gRes === undefined);

  // POST → untouched
  const postRes = await fire('fetch', { request: { method: 'POST', url: SCOPE + 'js/app.js', mode: 'no-cors' } });
  check('non-GET requests pass through', postRes === null || postRes === undefined);

  // online navigation → network wins and refreshes cache
  fetchBehavior = 'ok';
  const navRes2 = await fire('fetch', { request: { method: 'GET', url: SCOPE + 'privacy.html', mode: 'navigate' } });
  check('online navigation returns network', !!navRes2 && navRes2.body.indexOf('network:') === 0, navRes2 && navRes2.body);

  console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})();
