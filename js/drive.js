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
 *     us an OAuth access token with the drive.appdata scope (plus
 *     openid/email/profile so we can read the user's name and email).
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
 *   reauth    – Google sign-in expired and a sync is actually due;
 *               user taps once to reconnect (the tap is the user gesture
 *               the browser needs to open Google's popup)
 *   error     – Drive returned an unexpected error
 *
 * Boot behaviour: the access token lives in memory only, so every fresh
 * page load starts without one. We try ONE silent refresh (no popup);
 * when the browser blocks it (e.g. third-party cookies off — common on
 * phones) we stay quiet on "Ready" instead of nagging. The "Waiting to
 * sync" prompt appears only when the user changes something that really
 * needs Drive and the silent attempt fails then — it never demands a
 * tap, it just waits; background retries (coming online, reopening the
 * app, throttled while open) keep trying silently on their own.
 * ========================================================================= */
'use strict';

(function () {
  /* Global scope that works in the browser and in the Node test harness. */
  var G = (typeof window !== 'undefined') ? window
        : ((typeof globalThis !== 'undefined') ? globalThis : this);

  var SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
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
  /* reauthNeeded: the last silent token refresh failed (browser blocks
   * Google's silent iframe, e.g. third-party cookies off). The app keeps
   * working from the local cache; a tap is asked for only when a Drive
   * sync is actually due. Cleared by any fresh token. */
  var reauthNeeded = false;
  /* Quiet background retries, at most this often — never spam Google. */
  var SILENT_RETRY_MS = 5 * 60 * 1000;
  var lastSilentMs = 0;
  /* Account email used as login_hint for silent requests. */
  var loginHint = null;
  /* Local edits made while Drive had no token (not yet confirmed there). */
  var unsyncedChanges = false;
  /* The same flag, persisted in the browser: memory is wiped when the app
   * is closed, but an entry added offline must still reach Drive later —
   * and must never be mistaken for "in sync" on the next reconnect.
   * Keyed per Google account so accounts never share the flag. */
  var LS_DIRTY_PREFIX = 'hisab_drive_dirty_';
  function dirtyKey() {
    var p = null;
    try { p = readProfile(); } catch (e) {}
    var email = (p && p.email) ? String(p.email).toLowerCase() : (loginHint || 'default');
    return LS_DIRTY_PREFIX + email;
  }
  function persistedDirty() {
    try { return !!(G.localStorage && G.localStorage.getItem(dirtyKey()) === '1'); }
    catch (e) { return false; }
  }
  function persistDirty(on) {
    try {
      if (!G.localStorage) return;
      if (on) G.localStorage.setItem(dirtyKey(), '1');
      else G.localStorage.removeItem(dirtyKey());
    } catch (e) {}
  }
  /* Internal: local edits Drive hasn't confirmed — memory OR the
   * persisted flag, so a restart can't fake "in sync". */
  function hasUnsyncedChanges() { return unsyncedChanges || persistedDirty(); }

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
        callback: onTokenResponse,
        /* Fires when the Google popup is closed, blocked, or fails —
         * without this the sign-in button would wait forever. */
        error_callback: onTokenError
      });
    }
    return tokenClient;
  }

  function onTokenResponse(resp) {
    var cb = pendingResolve; pendingResolve = null;
    if (resp && resp.access_token) {
      accessToken = resp.access_token;
      reauthNeeded = false; /* any fresh token clears the tap requirement */
      if (cb) cb(null);
    } else if (cb) {
      cb(new Error((resp && resp.error) || 'token-denied'));
    }
  }

  function onTokenError(err) {
    var cb = pendingResolve; pendingResolve = null;
    var type = (err && err.type) || 'popup-failed';
    if (type === 'popup_closed') type = 'popup_closed_by_user';
    if (cb) cb(new Error(type));
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
    if (typeof provider === 'function') {
      payloadProvider = provider;
      unsyncedChanges = true; /* local edits Drive hasn't confirmed yet */
    }
    /* Persist the flag too: if the app is closed before the upload lands
     * (offline, expired token…), the next boot still knows Drive is behind. */
    if (payloadProvider) persistDirty(true);
    if (!accessToken) {
      /* Not signed in with Google right now — nothing to sync yet.
       * When Google needs a tap (reauthNeeded), ask for it only now that
       * there is actually something to upload: one quiet silent attempt
       * first, then the "Waiting to sync" state. */
      if (!online()) { setStatus('offline'); dirtyWhileOffline = true; return; }
      if (reauthNeeded) {
        if (Date.now() - lastSilentMs >= SILENT_RETRY_MS) {
          lastSilentMs = Date.now();
          setStatus('syncing');
          requestToken('none', loginHint).then(function (err) {
            if (err || !accessToken) { setStatus('reauth'); return; }
            reauthNeeded = false;
            scheduleSave();
          });
        } else {
          setStatus('reauth');
        }
      }
      return;
    }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!online()) { setStatus('offline'); dirtyWhileOffline = true; return; }
    setStatus('syncing');
    saveTimer = setTimeout(flushSave, DEBOUNCE_MS);
  }

  function flushSave() {
    /* An explicit flush supersedes any pending debounced save. */
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveTimer = null;
    if (!accessToken || !payloadProvider) return Promise.resolve(false);
    if (!online()) { setStatus('offline'); dirtyWhileOffline = true; return Promise.resolve(false); }
    var payload;
    try { payload = payloadProvider(); }
    catch (e) { return Promise.resolve(false); }
    return saveRemote(payload).then(function () {
      setStatus('synced');
      unsyncedChanges = false;
      persistDirty(false); /* Drive confirmed it — survives restarts too */
      return true;
    }).catch(function (e) {
      if (e && e.message === 'reauth-needed') setStatus('reauth');
      else if (e && e.message === 'network-offline') setStatus('offline');
      else setStatus('error');
      return false;
    });
  }

  /* Call after a successful load-from-Drive: we are in sync, nothing pending. */
  function markInSync() { unsyncedChanges = false; persistDirty(false); setStatus(accessToken ? 'synced' : 'idle'); }

  /* Call when a Google session is restored from the local cache without a
   * live token (fresh page load): the app opens from the cache and works
   * offline-capable; Drive reconnects silently when it can, otherwise the
   * user taps once at the moment a sync is actually due. */
  function noteReauth() { setStatus('reauth'); }

  /* Try to refresh the Google token silently (no popup, no user gesture).
   * Resolves true when Drive sync is live again, false when Google
   * genuinely needs the user to tap and reconnect. A failed silent
   * attempt at boot stays QUIET (status 'idle', app works from cache);
   * the tap prompt is raised later, only when a sync is actually due. */
  function silentReconnect(hint) {
    if (!configured() || !gisLoaded()) return Promise.resolve(false);
    if (accessToken) {
      reauthNeeded = false;
      if (hasUnsyncedChanges() && payloadProvider) scheduleSave();
      if (status === 'reauth' || status === 'disabled') setStatus('idle');
      return Promise.resolve(true);
    }
    if (hint) loginHint = hint;
    lastSilentMs = Date.now();
    setStatus('syncing');
    return requestToken('none', loginHint).then(function (err) {
      if (err) {
        reauthNeeded = true;
        setStatus('idle');
        return false;
      }
      reauthNeeded = false;
      /* Token's back — push anything the app couldn't upload earlier
       * (e.g. entries added offline before the app was closed). */
      if (hasUnsyncedChanges() && payloadProvider) scheduleSave();
      setStatus('idle');
      return true;
    });
  }

  /* Retry pending uploads when the browser comes back online, or when the
   * app is reopened after being in the background. If the only thing
   * missing is the token, take another quiet silent shot — this lets the
   * app reconnect by itself whenever Google allows it. The persisted
   * dirty flag is consulted (not just memory), so edits made offline
   * before the app was closed still get their retry. */
  function backgroundRetry() {
    if (!accessToken && hasUnsyncedChanges() &&
        gisLoaded() && configured() &&
        Date.now() - lastSilentMs >= SILENT_RETRY_MS) {
      silentReconnect().then(function (ok) {
        if (ok) { dirtyWhileOffline = false; if (payloadProvider) scheduleSave(); }
      });
    }
  }
  if (typeof G.addEventListener === 'function') {
    G.addEventListener('online', function () {
      if (dirtyWhileOffline && accessToken) { dirtyWhileOffline = false; scheduleSave(); }
      else backgroundRetry();
    });
    if (G.document && typeof G.document.addEventListener === 'function') {
      G.document.addEventListener('visibilitychange', function () {
        if (G.document.visibilityState === 'visible') backgroundRetry();
      });
    }
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
    if (p && p.email) loginHint = String(p.email).toLowerCase();
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
    persistDirty(false); /* signed out — nothing pending for this account */
    reauthNeeded = false;
    lastSilentMs = 0;
    loginHint = null;
    unsyncedChanges = false;
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
    noteReauth: noteReauth,
    silentReconnect: silentReconnect,
    hasToken: function () { return !!accessToken; },
    /* True when local edits exist that Drive hasn't confirmed yet —
     * consults the persisted flag too, so a restart can't fake "in sync". */
    hasUnsyncedChanges: hasUnsyncedChanges,
    readProfile: readProfile,
    writeProfile: writeProfile,
    /* test helpers */
    _setDebounceMs: function (ms) { DEBOUNCE_MS = ms; },
    _setLastSilentMs: function (ms) { lastSilentMs = ms; },
    _reset: function () {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      tokenClient = null; accessToken = null; fileId = null;
      payloadProvider = null; dirtyWhileOffline = false; pendingResolve = null;
      reauthNeeded = false; lastSilentMs = 0; loginHint = null;
      unsyncedChanges = false;
      statusListeners = []; status = 'disabled';
    }
  };
})();
