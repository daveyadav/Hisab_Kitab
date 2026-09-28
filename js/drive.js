/* =========================================================================
 * Hisab — Google Drive sync layer (js/drive.js).
 *
 * Lets people sign in with Google and keep their Hisab records in a
 * hidden app folder inside THEIR OWN Google Drive (the special
 * "appDataFolder" space — the app can only see files it created
 * itself, never the user's other Drive files).
 *
 * How it works:
 *   - Google Identity Services (loaded from accounts.google.com) gives
 *     us an OAuth access token with the drive.appdata scope.
 *   - The token lives in memory only and is never written to storage.
 *   - We keep a local copy of the synced records in localStorage
 *     (same key the app already uses), so the app also opens offline.
 *   - Every change is saved locally first, then uploaded to Drive
 *     with a 2-second debounce. Last write wins (updatedAt stamp).
 *   - Only the signed-in Google account's Drive is ever touched;
 *     local device-only accounts never call any of this.
 *
 * Status values (subscribed via Drive.onStatus):
 *   disabled  – Google not in use / not configured
 *   idle      – signed in, nothing pending
 *   syncing   – an upload is in progress
 *   synced    – last upload succeeded
 *   offline   – no internet; changes are kept locally and retried later
 *   reauth    – Google sign-in expired; user must tap to reconnect
 *   error     – Drive returned an unexpected error
 * ========================================================================= */
'use strict';

(function () {
  /* Global scope that works in the browser and in the Node test harness. */
  var G = (typeof window !== 'undefined') ? window
        : ((typeof globalThis !== 'undefined') ? globalThis : this);

  var SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  var FILE_NAME = 'hisab-data.json';
  var LS_PROFILE = 'hisab_google_profile';
  var DEBOUNCE_MS = 2000;

  var tokenClient = null;
  var accessToken = null;   /* memory only — never persisted */
  var fileId = null;        /* Drive file id for this session */
  var status = 'disabled';
  var statusListeners = [];
  var saveTimer = null;
  var payloadProvider = null;
  var dirtyWhileOffline = false;
  var pendingResolve = null;

  /* ---------------- config / environment ---------------- */

  function clientId() {
    return (G.HISAB_CONFIG && G.HISAB_CONFIG.GOOGLE_CLIENT_ID) || '';
  }
  function configured() {
    var c = clientId();
    return !!(c && c.indexOf('PASTE') !== 0 && c.length > 10);
  }
  function gisLoaded() {
    return !!(G.google && G.google.accounts && G.google.accounts.oauth2 &&
              typeof G.google.accounts.oauth2.initTokenClient === 'function');
  }
  function online() {
    return !G.navigator || G.navigator.onLine !== false;
  }
  function fetchFn() {
    if (typeof G.fetch === 'function') return G.fetch;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  /* UI state for the auth screens:
   *   'ready'          – button enabled, sign-in works
   *   'no-client-id'   – config.js still has the placeholder
   *   'loading-gis'    – waiting for Google's script to load
   *   'needs-internet' – offline, and Google's script isn't cached      */
  function uiState() {
    if (!configured()) return 'no-client-id';
    if (gisLoaded()) return 'ready';
    if (!online()) return 'needs-internet';
    return 'loading-gis';
  }

  function setStatus(s) {
    if (status === s) return;
    status = s;
    for (var i = 0; i < statusListeners.length; i++) {
      try { statusListeners[i](s); } catch (e) {}
    }
  }
  function onStatus(fn) { if (typeof fn === 'function') statusListeners.push(fn); }

  /* ---------------- token handling ---------------- */

  function ensureTokenClient() {
    if (!tokenClient) {
      tokenClient = G.google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: SCOPE,
        callback: onTokenResponse
      });
    }
    return tokenClient;
  }

  function onTokenResponse(resp) {
    var cb = pendingResolve; pendingResolve = null;
    if (resp && resp.access_token) {
      accessToken = resp.access_token;
      if (cb) cb(null);
    } else if (cb) {
      cb(new Error((resp && resp.error) || 'token-denied'));
    }
  }

  /* prompt: '' (default), 'none' (silent), 'select_account', 'consent'.
   * Resolves with null on success, or an Error.                         */
  function requestToken(promptMode, hint) {
    return new Promise(function (resolve) {
      if (!gisLoaded() || !configured()) { resolve(new Error('google-unavailable')); return; }
      pendingResolve = resolve;
      try {
        var cfg = { prompt: (promptMode == null ? '' : promptMode) };
        if (hint) cfg.hint = hint;
        ensureTokenClient().requestAccessToken(cfg);
      } catch (e) {
        pendingResolve = null;
        resolve(e);
      }
    });
  }

  /* ---------------- Drive API ---------------- */

  function api(path, opts, retried) {
    var f = fetchFn();
    if (!f) return Promise.reject(new Error('no-fetch'));
    var o = {};
    for (var k in (opts || {})) o[k] = opts[k];
    o.headers = {};
    for (var h in ((opts || {}).headers || {})) o.headers[h] = opts.headers[h];
    o.headers['Authorization'] = 'Bearer ' + accessToken;

    return f('https://www.googleapis.com' + path, o).then(function (res) {
      if (res.status === 401 && !retried) {
        /* Token expired — try one silent refresh, then ask the user. */
        return requestToken('none').then(function (err) {
          if (err) { setStatus('reauth'); throw new Error('reauth-needed'); }
          return api(path, opts, true);
        });
      }
      return res;
    }, function (netErr) {
      setStatus('offline');
      var e = new Error('network-offline');
      e.cause = netErr;
      throw e;
    });
  }

  function fetchProfile() {
    return api('/oauth2/v3/userinfo', { method: 'GET' }).then(function (res) {
      if (!res.ok) throw new Error('userinfo-failed');
      return res.json();
    }).then(function (u) {
      return {
        email: String(u.email || '').toLowerCase(),
        name: u.name || u.email || '',
        picture: u.picture || ''
      };
    });
  }

  /* Full sign-in: token → profile. `hint` pre-fills the account chooser. */
  function signIn(hint) {
    setStatus('syncing');
    return requestToken('', hint || undefined).then(function (err) {
      if (err) { setStatus('idle'); throw err; }
      return fetchProfile();
    });
  }

  function listFile() {
    var q = "'appDataFolder' in parents and name='" + FILE_NAME + "' and trashed=false";
    return api('/drive/v3/files?q=' + encodeURIComponent(q) +
      '&spaces=appDataFolder&fields=files(id%2Cname%2CmodifiedTime)&pageSize=1',
      { method: 'GET' }
    ).then(function (res) {
      if (!res.ok) throw new Error('drive-list-failed');
      return res.json();
    }).then(function (j) {
      return (j && j.files && j.files[0]) || null;
    });
  }

  /* Returns the parsed remote payload, or null when there is none yet. */
  function loadRemote() {
    return listFile().then(function (f) {
      if (!f) { fileId = null; return null; }
      fileId = f.id;
      return api('/drive/v3/files/' + encodeURIComponent(f.id) + '?alt=media', { method: 'GET' })
        .then(function (res) {
          if (!res.ok) throw new Error('drive-download-failed');
          return res.json();
        });
    });
  }

  function createFile(payload) {
    var metadata = { name: FILE_NAME, parents: ['appDataFolder'] };
    var boundary = 'hisab' + Date.now().toString(36);
    var body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(payload) + '\r\n' +
      '--' + boundary + '--';
    return api('/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    }).then(function (res) {
      if (!res.ok) throw new Error('drive-create-failed');
      return res.json();
    }).then(function (j) { fileId = j.id; return true; });
  }

  function updateFile(payload) {
    return api('/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?uploadType=media', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('drive-update-failed');
      return true;
    });
  }

  function saveRemote(payload) {
    function go() {
      if (fileId) return updateFile(payload);
      return listFile().then(function (f) {
        fileId = f ? f.id : null;
        return fileId ? updateFile(payload) : createFile(payload);
      });
    }
    return go();
  }

  /* ---------------- debounced saving ---------------- */

  function scheduleSave(provider) {
    if (typeof provider === 'function') payloadProvider = provider;
    if (!accessToken) return; /* not signed in with Google — nothing to sync */
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!online()) { setStatus('offline'); dirtyWhileOffline = true; return; }
    setStatus('syncing');
    saveTimer = setTimeout(flushSave, DEBOUNCE_MS);
  }

  function flushSave() {
    saveTimer = null;
    if (!accessToken || !payloadProvider) return Promise.resolve(false);
    if (!online()) { setStatus('offline'); dirtyWhileOffline = true; return Promise.resolve(false); }
    var payload;
    try { payload = payloadProvider(); }
    catch (e) { return Promise.resolve(false); }
    return saveRemote(payload).then(function () {
      setStatus('synced');
      return true;
    }).catch(function (e) {
      if (e && e.message === 'reauth-needed') setStatus('reauth');
      else if (e && e.message === 'network-offline') setStatus('offline');
      else setStatus('error');
      return false;
    });
  }

  /* Call after a successful load-from-Drive: we are in sync, nothing pending. */
  function markInSync() { setStatus(accessToken ? 'synced' : 'idle'); }

  /* Retry pending uploads when the browser comes back online. */
  if (typeof G.addEventListener === 'function') {
    G.addEventListener('online', function () {
      if (dirtyWhileOffline && accessToken) { dirtyWhileOffline = false; scheduleSave(); }
    });
  }

  /* ---------------- profile persistence (for "Continue as …") ---------------- */

  function readProfile() {
    try {
      var raw = G.localStorage && G.localStorage.getItem(LS_PROFILE);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeProfile(p) {
    try {
      if (G.localStorage) G.localStorage.setItem(LS_PROFILE,
        JSON.stringify({ email: p.email, name: p.name, picture: p.picture }));
    } catch (e) {}
  }
  function clearProfile() {
    try { if (G.localStorage) G.localStorage.removeItem(LS_PROFILE); } catch (e) {}
  }

  function signOut() {
    var t = accessToken;
    accessToken = null;
    fileId = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    payloadProvider = null;
    dirtyWhileOffline = false;
    clearProfile();
    setStatus('disabled');
    if (t && gisLoaded()) {
      try { G.google.accounts.oauth2.revoke(t, function () {}); } catch (e) {}
    }
  }

  /* ---------------- public API ---------------- */

  G.Drive = {
    configured: configured,
    gisLoaded: gisLoaded,
    uiState: uiState,
    getStatus: function () { return status; },
    onStatus: onStatus,
    signIn: signIn,
    signOut: signOut,
    loadRemote: loadRemote,
    scheduleSave: scheduleSave,
    flushSave: flushSave,
    markInSync: markInSync,
    hasToken: function () { return !!accessToken; },
    readProfile: readProfile,
    writeProfile: writeProfile,
    /* test helpers */
    _setDebounceMs: function (ms) { DEBOUNCE_MS = ms; },
    _reset: function () {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      tokenClient = null; accessToken = null; fileId = null;
      payloadProvider = null; dirtyWhileOffline = false; pendingResolve = null;
      statusListeners = []; status = 'disabled';
    }
  };
})();
