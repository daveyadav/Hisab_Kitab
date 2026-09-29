/* Hisab Google Drive sync — smoke tests with a MOCKED Google backend.
 * Part A: js/drive.js unit tests (mocked GIS token client + fake Drive API).
 * Part B: js/app.js integration (DOM-stubbed, real drive.js, mocked Google).
 *
 * Covers: uiState for missing client ID / missing GIS / offline,
 * Google sign-in → profile, loadRemote empty/existing, debounced save
 * roundtrip, per-email isolation, 401 → silent re-auth → retry,
 * re-auth failure → 'reauth' status, signOut, local accounts untouched
 * by Drive, Google↔local account isolation, Google session auto-restore
 * from cache with no auto-popup on boot, quiet boot when silent refresh
 * fails (calm "Waiting to sync" only when a sync is actually due, silent
 * retries throttled in the background), reconnect preserving unsynced
 * local edits instead of the stale remote copy wiping them, local
 * session surviving reload.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');
const JS = require('path').join(__dirname, '..', 'js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

/* ---------------- fake Google backend ---------------- */

function extractMultipartPayload(body) {
  const parts = String(body).split('--');
  for (const part of parts) {
    const i = part.indexOf('\r\n\r\n');
    if (i === -1) continue;
    let tail = part.slice(i + 4);
    const end = tail.lastIndexOf('\r\n');
    const candidate = tail.slice(0, end < 0 ? undefined : end).trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && obj.entries) return obj;
    } catch (e) {}
  }
  throw new Error('mock: could not parse multipart payload');
}

function makeFake() {
  const fake = {
    calls: [], tokenRequests: [], revoked: [],
    emailForToken: {}, stores: {}, fileSeq: 0, tokenSeq: 0,
    currentEmail: 'alice@gmail.com',
    reauthShouldFail: false,
    failOnce401: new Set(),
    lastToken: null,
    tokenCallback: null,
  };

  const tokenClient = {
    requestAccessToken(cfg = {}) {
      fake.tokenRequests.push(cfg);
      setTimeout(() => {
        if (fake.reauthShouldFail && cfg.prompt === 'none') {
          fake.tokenCallback({ error: 'interaction_required' });
          return;
        }
        const tok = 'tok-' + (++fake.tokenSeq);
        const prevEmail = fake.emailForToken[fake.lastToken];
        fake.emailForToken[tok] = (cfg.prompt === 'none' && prevEmail) ? prevEmail : fake.currentEmail;
        fake.lastToken = tok;
        fake.tokenCallback({ access_token: tok });
      }, 5);
    },
  };

  fake.google = {
    accounts: {
      oauth2: {
        initTokenClient(opts) { fake.tokenCallback = opts.callback; return tokenClient; },
        revoke(t, cb) { fake.revoked.push(t); if (cb) cb(); },
      },
    },
  };

  fake.fetch = async function (url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const auth = ((opts.headers || {})['Authorization'] || '').replace('Bearer ', '');
    fake.calls.push({ method, url, token: auth });
    const email = fake.emailForToken[auth];
    const res = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
    if (!email) return res(401, { error: 'bad token' });
    if (fake.failOnce401.has(auth)) { fake.failOnce401.delete(auth); return res(401, { error: 'expired' }); }
    const u = new URL(url);
    const store = fake.stores[email] || (fake.stores[email] = { files: {} });
    if (u.pathname === '/oauth2/v3/userinfo') {
      return res(200, { email, name: email.split('@')[0], picture: 'https://pics.example/' + email });
    }
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const files = Object.entries(store.files).map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime }));
      return res(200, { files });
    }
    let m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'GET' && u.searchParams.get('alt') === 'media') {
      const f = store.files[m[1]];
      return f ? res(200, JSON.parse(f.content)) : res(404, {});
    }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const payload = extractMultipartPayload(opts.body);
      const id = 'file' + (++fake.fileSeq);
      store.files[id] = { name: 'hisab-data.json', content: JSON.stringify(payload), modifiedTime: new Date().toISOString() };
      return res(200, { id, name: 'hisab-data.json' });
    }
    m = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const f = store.files[m[1]];
      if (!f) return res(404, {});
      f.content = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      f.modifiedTime = new Date().toISOString();
      return res(200, { id: m[1] });
    }
    return res(400, { error: 'unmocked ' + method + ' ' + u.pathname });
  };

  fake.uploadCalls = () => fake.calls.filter(c => c.url.includes('/upload/drive/v3/files'));
  return fake;
}

/* ---------------- DOM stub ---------------- */

function makeEl(id) {
  const el = {
    id: id || '', innerHTML: '', textContent: '', value: '', src: '',
    hidden: false, disabled: false, dataset: {}, style: {}, className: '',
    selectionStart: 0, onclick: null,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    _handlers: {},
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    removeEventListener() {},
    appendChild() {}, remove() {},
    click() {
      if (typeof this.onclick === 'function') this.onclick();
      (this._handlers.click || []).forEach(f => f({ preventDefault() {} }));
    },
    focus() {}, reset() {}, setSelectionRange() {},
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
  };
  return el;
}

function makeContext({ clientId = 'test-client-123.apps.googleusercontent.com', gisPresent = true, online = true } = {}) {
  const store = {};
  const localStorage = {
    getItem: k => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const fake = makeFake();
  const loadHandlers = [];
  const windowStub = {
    localStorage,
    navigator: { onLine: online },
    addEventListener(t, fn) { if (t === 'load' && typeof fn === 'function') loadHandlers.push(fn); },
    removeEventListener() {}, scrollTo() {},
    crypto: webcrypto, isSecureContext: true,
    HISAB_CONFIG: { GOOGLE_CLIENT_ID: clientId },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  if (gisPresent) windowStub.google = fake.google;
  windowStub.fetch = fake.fetch;

  let domReadyHandler = null;
  const elCache = {};
  const documentStub = {
    querySelector(sel) { if (!elCache[sel]) elCache[sel] = makeEl(sel); return elCache[sel]; },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    addEventListener(t, fn) { if (t === 'DOMContentLoaded') domReadyHandler = fn; },
    removeEventListener() {},
    body: makeEl('body'),
    readyState: 'loading', /* fireLoad() flips this, like a real page load */
  };
  const sandbox = {
    window: windowStub, document: documentStub, localStorage,
    navigator: windowStub.navigator, crypto: webcrypto,
    TextEncoder, Intl, console, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { reload() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS + '/drive.js', 'utf8'), sandbox, { filename: 'drive.js' });
  sandbox.Drive = windowStub.Drive; /* window props are globals in a real browser */
  vm.runInContext(fs.readFileSync(JS + '/app.js', 'utf8'), sandbox, { filename: 'app.js' });
  return {
    sandbox, windowStub, documentStub, fake, store,
    $: sel => documentStub.querySelector(sel),
    fireReady: () => { if (domReadyHandler) domReadyHandler(); },
    fireLoad: () => {
      documentStub.readyState = 'complete';
      loadHandlers.splice(0).forEach(fn => { try { fn(); } catch (e) {} });
    },
  };
}

function drivePayloadFor(email, descs) {
  return {
    app: 'hisab', version: 3, updatedAt: Date.now(),
    entries: {
      personal: descs.map(d => ({ id: 'x' + d, ts: Date.now(), type: 'cash_purchase', desc: d, amount: 100, party: '', note: '' })),
      business: [],
    },
  };
}

(async () => {
  console.log('--- Part A: drive.js unit tests ---');

  // A1-A4: uiState matrix
  {
    const c1 = makeContext({ clientId: 'PASTE_YOUR_CLIENT_ID_HERE' });
    check('A1 uiState no-client-id on placeholder', c1.windowStub.Drive.uiState() === 'no-client-id');
    const c2 = makeContext();
    check('A2 uiState ready when configured + GIS loaded', c2.windowStub.Drive.uiState() === 'ready');
    const c3 = makeContext({ gisPresent: false, online: false });
    check('A3 uiState needs-internet when GIS missing + offline', c3.windowStub.Drive.uiState() === 'needs-internet');
    const c4 = makeContext({ gisPresent: false, online: true });
    check('A4 uiState loading-gis when GIS missing + online', c4.windowStub.Drive.uiState() === 'loading-gis');
  }

  // A5-A7: sign-in, load empty, debounced save roundtrip
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive._setDebounceMs(30);
    const prof = await Drive.signIn();
    check('A5 signIn returns profile email', prof && prof.email === 'alice@gmail.com', JSON.stringify(prof));
    check('A5 token held in memory', Drive.hasToken() === true);
    const remote = await Drive.loadRemote();
    check('A6 loadRemote null when no file yet', remote === null);
    Drive.scheduleSave(() => drivePayloadFor('alice', ['Momo', 'Chiya']));
    Drive.scheduleSave(() => drivePayloadFor('alice', ['Momo', 'Chiya'])); // rapid second call
    await tick(300);
    const ups = c.fake.uploadCalls();
    check('A7 two rapid saves → single upload (debounced)', ups.length === 1, 'got ' + ups.length);
    const stored = c.fake.stores['alice@gmail.com'];
    const fid = Object.keys(stored.files)[0];
    const saved = JSON.parse(stored.files[fid].content);
    check('A7 uploaded payload has entries + updatedAt',
      saved.entries.personal.length === 2 && typeof saved.updatedAt === 'number' && saved.app === 'hisab');
    check('A7 status ends synced', Drive.getStatus() === 'synced', Drive.getStatus());
  }

  // A8: per-email isolation
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive._setDebounceMs(30);
    await Drive.signIn(); // alice
    Drive.scheduleSave(() => drivePayloadFor('alice', ['AliceEntry']));
    await tick(300);
    Drive._reset();
    c.fake.currentEmail = 'bob@gmail.com';
    await Drive.signIn(); // bob
    const remote = await Drive.loadRemote();
    check('A8 bob sees no file (isolation from alice)', remote === null);
    Drive.scheduleSave(() => drivePayloadFor('bob', ['BobEntry']));
    await tick(300);
    const aFiles = Object.keys(c.fake.stores['alice@gmail.com'].files).length;
    const bFiles = Object.keys(c.fake.stores['bob@gmail.com'].files).length;
    const bContent = JSON.parse(Object.values(c.fake.stores['bob@gmail.com'].files)[0].content);
    check('A8 stores stay separate per email',
      aFiles === 1 && bFiles === 1 && bContent.entries.personal[0].desc === 'BobEntry');
  }

  // A9: 401 → no silent retry; the dead token is dropped, the tappable
  // state shows, and the user's tap re-authenticates and uploads.
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive._setDebounceMs(30);
    await Drive.signIn(); // tok-1
    Drive.scheduleSave(() => drivePayloadFor('alice', ['First']));
    await tick(300);
    check('A9 first upload landed', c.fake.uploadCalls().length === 1,
      String(c.fake.uploadCalls().length));
    const reqsBefore = c.fake.tokenRequests.length;
    c.fake.failOnce401.add(c.fake.lastToken);
    Drive.scheduleSave(() => drivePayloadFor('alice', ['Second']));
    await tick(600);
    check('A9 401 triggers no silent token request', c.fake.tokenRequests.length === reqsBefore,
      'requests: ' + c.fake.tokenRequests.length + ' vs ' + reqsBefore);
    check('A9 dead token dropped after 401', Drive.hasToken() === false);
    check('A9 401 surfaces reauth status', Drive.getStatus() === 'reauth', Drive.getStatus());
    const storedMid = c.fake.stores['alice@gmail.com'];
    const mid = JSON.parse(Object.values(storedMid.files)[0].content);
    check('A9 failed upload left the old Drive data in place',
      mid.entries.personal[0].desc === 'First', mid.entries.personal[0].desc);
    /* The tap: interactive sign-in, then the pending edit uploads. */
    await Drive.signIn();
    Drive.scheduleSave(() => drivePayloadFor('alice', ['Second']));
    await Drive.flushSave();
    await tick(200);
    check('A9 status synced after the tap', Drive.getStatus() === 'synced', Drive.getStatus());
    const stored = c.fake.stores['alice@gmail.com'];
    const latest = JSON.parse(Object.values(stored.files)[0].content);
    check('A9 retried upload persisted', latest.entries.personal[0].desc === 'Second');
  }

  // A10: re-auth failure → 'reauth' status
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive._setDebounceMs(30);
    await Drive.signIn();
    const log = [];
    Drive.onStatus(s => log.push(s));
    c.fake.reauthShouldFail = true;
    c.fake.failOnce401.add(c.fake.lastToken);
    Drive.scheduleSave(() => drivePayloadFor('alice', ['X']));
    await tick(600);
    check('A10 failed re-auth surfaces reauth status', log.includes('reauth'), log.join(','));
  }

  // A11: signOut
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    await Drive.signIn();
    Drive.writeProfile({ email: 'alice@gmail.com', name: 'Alice', picture: '' });
    Drive.signOut();
    check('A11 signOut clears token', Drive.hasToken() === false);
    check('A11 signOut revokes token with Google', c.fake.revoked.length === 1);
    check('A11 signOut clears stored profile', Drive.readProfile() === null);
    check('A11 signOut status disabled', Drive.getStatus() === 'disabled');
  }

  console.log('--- Part B: app.js integration ---');

  // B1: boot → Google button enabled when configured
  {
    const c = makeContext();
    c.sandbox.Drive._setDebounceMs(30);
    c.fireReady();
    await tick(100);
    check('B1 login view shown on fresh boot', c.$('#view-login').hidden === false);
    check('B1 Google button enabled when configured', c.$('#google-btn-login').disabled === false);
    check('B1 Google sub-label mentions sync', /sync/i.test(c.$('#google-sub-login').textContent));
  }

  // B2: placeholder client ID → disabled button + helpful note
  {
    const c = makeContext({ clientId: 'PASTE_YOUR_CLIENT_ID_HERE' });
    c.fireReady();
    await tick(100);
    check('B2 Google button disabled without client ID', c.$('#google-btn-login').disabled === true);
    const note = c.$('#google-note-login');
    check('B2 helpful note shown', note.hidden === false && /config\.js/i.test(note.textContent), note.textContent);
  }

  // B3-B5: Google sign-in → entries sync → bob isolated
  {
    const c = makeContext();
    c.sandbox.Drive._setDebounceMs(30);
    c.fireReady();
    await tick(100);
    c.$('#google-btn-login').click();
    await tick(500);
    check('B3 Google sign-in lands in main view', c.$('#view-main').hidden === false);
    check('B3 S.user is google kind', c.sandbox.S.user && c.sandbox.S.user.kind === 'google');
    const sess = JSON.parse(c.store['hisab_session_v2']);
    check('B3 session stores google kind+id', sess.kind === 'google' && sess.id === 'alice@gmail.com', JSON.stringify(sess));
    check('B3 sync pill visible after login', c.$('#sync-pill').hidden === false);
    check('B3 pill shows synced', /synced/i.test(c.$('#sync-pill').innerHTML), c.$('#sync-pill').innerHTML);

    // B4: add entry → debounced Drive upload with the entry
    c.sandbox.addEntry({ ts: Date.now(), type: 'cash_purchase', desc: 'Test momo', amount: 250, party: 'Momo house', note: '' });
    await tick(500);
    const ups = c.fake.uploadCalls();
    check('B4 entry mutation triggers Drive upload', ups.length >= 1, 'uploads: ' + ups.length);
    const stored = c.fake.stores['alice@gmail.com'];
    const content = JSON.parse(Object.values(stored.files)[0].content);
    check('B4 uploaded data contains the entry',
      content.entries.personal.some(e => e.desc === 'Test momo' && e.amount === 250));
    check('B4 local cache key is namespaced per google account',
      !!c.store['hisab_data_v2_g_alice@gmail.com']);

    // B5: logout → bob signs in → isolated, fresh
    c.sandbox.logout();
    c.fake.currentEmail = 'bob@gmail.com';
    c.$('#google-btn-login').click();
    await tick(500);
    check('B5 bob signed in as google', c.sandbox.S.user && c.sandbox.S.user.id === 'bob@gmail.com');
    check('B5 bob sees empty personal entries', c.sandbox.S.entries.personal.length === 0);
    check('B5 alice data untouched in her namespace',
      JSON.parse(c.store['hisab_data_v2_g_alice@gmail.com']).personal.some(e => e.desc === 'Test momo'));

    // B8 (folded in): back to alice → her entry still there
    c.sandbox.logout();
    c.fake.currentEmail = 'alice@gmail.com';
    c.$('#google-btn-login').click();
    await tick(500);
    check('B8 alice re-login restores her synced entry',
      c.sandbox.S.entries.personal.some(e => e.desc === 'Test momo'));
  }

  // B6: local accounts never touch Drive
  {
    const c = makeContext();
    c.sandbox.Drive._setDebounceMs(30);
    c.fireReady();
    await tick(100);
    c.$('#create-username').value = 'kaza';
    c.$('#create-password').value = 'secret1';
    c.$('#create-password2').value = 'secret1';
    c.sandbox.handleCreate({ preventDefault() {} });
    await tick(200);
    check('B6 local account created', c.sandbox.S.user && c.sandbox.S.user.kind === 'local');
    c.sandbox.addEntry({ ts: Date.now(), type: 'cash_purchase', desc: 'Local only', amount: 99, party: '', note: '' });
    await tick(400);
    check('B6 no Drive upload for local account', c.fake.uploadCalls().length === 0);
    check('B6 sync pill hidden for local account', c.$('#sync-pill').hidden === true);
  }

  // B7: boot with google session → auto-restore from cache, ZERO Google
  // contact (GIS opens a popup even for "silent" requests — that's the
  // redirect-to-Google flash on every refresh). No nag, entries visible.
  {
    const c = makeContext();
    c.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'alice@gmail.com' });
    c.store['hisab_google_profile'] = JSON.stringify({ email: 'alice@gmail.com', name: 'Alice', picture: '' });
    c.store['hisab_data_v2_g_alice@gmail.com'] = JSON.stringify({ personal: [
      { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Cached momo', amount: 150, party: '', note: '' },
    ], business: [] });
    c.fireReady();
    c.fireLoad(); /* real browsers fire load right after DOMContentLoaded */
    await tick(900);
    check('B7 main view auto-opened on boot', c.$('#view-main').hidden === false);
    check('B7 restored as the same google user',
      c.sandbox.S.user && c.sandbox.S.user.kind === 'google' && c.sandbox.S.user.id === 'alice@gmail.com');
    check('B7 boot makes zero token requests (no silent popup, no redirect)',
      c.fake.tokenRequests.length === 0,
      JSON.stringify(c.fake.tokenRequests));
    check('B7 no nag at boot — pill Ready',
      /ready/i.test(c.$('#sync-pill').innerHTML), c.$('#sync-pill').innerHTML);
    check('B7 cached entries visible',
      c.sandbox.S.entries.personal.some(e => e.desc === 'Cached momo'));
  }

  // B7b: boot never contacts Google; a calm "Waiting to sync" appears only
  // when the user changes something that actually needs syncing. The tap
  // is an explicit interactive reconnect (user gesture → popup allowed).
  {
    const c = makeContext();
    c.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'ana@example.com' });
    c.store['hisab_google_profile'] = JSON.stringify({ email: 'ana@example.com', name: 'Ana', picture: '' });
    c.store['hisab_data_v2_g_ana@example.com'] = JSON.stringify({ personal: [
      { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Cached momo', amount: 150, party: '', note: '' },
    ], business: [] });
    c.fireReady();
    c.fireLoad();
    await tick(900);
    check('B7b no token request at boot',
      c.fake.tokenRequests.length === 0,
      JSON.stringify(c.fake.tokenRequests));
    const pill = c.$('#sync-pill');
    check('B7b no nag at boot — pill Ready',
      pill.hidden === false && /ready/i.test(pill.innerHTML), pill.innerHTML);
    /* User adds an entry → now a sync is actually due → the pill may ask. */
    c.sandbox.addEntry({ ts: Date.now(), type: 'cash_purchase', desc: 'New chiya', amount: 80, party: '', note: '' });
    await tick(400);
    check('B7b pill shows "Waiting to sync" only when a sync is due',
      /waiting to sync/i.test(pill.innerHTML), pill.innerHTML);
    check('B7b the edit triggered no silent token request',
      c.fake.tokenRequests.length === 0,
      JSON.stringify(c.fake.tokenRequests));
    const reqsBeforeTap = c.fake.tokenRequests.length;
    c.fake.currentEmail = 'ana@example.com'; /* tap signs back into the same account */
    pill.click();
    await tick(150);
    check('B7b tapping triggers an interactive reconnect, never a silent one',
      c.fake.tokenRequests.length === reqsBeforeTap + 1 &&
      c.fake.tokenRequests[c.fake.tokenRequests.length - 1].prompt !== 'none',
      JSON.stringify(c.fake.tokenRequests));
  }

  // B7f: reconnecting after offline edits keeps them — the stale remote
  // copy must not wipe entries made while the token was expired
  {
    const c = makeContext();
    c.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'ana@example.com' });
    c.store['hisab_google_profile'] = JSON.stringify({ email: 'ana@example.com', name: 'Ana', picture: '' });
    c.store['hisab_data_v2_g_ana@example.com'] = JSON.stringify({ personal: [
      { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Cached momo', amount: 150, party: '', note: '' },
    ], business: [] });
    c.fireReady();
    c.fireLoad();
    await tick(900);
    c.sandbox.addEntry({ ts: Date.now(), type: 'cash_purchase', desc: 'Offline chiya', amount: 80, party: '', note: '' });
    await tick(400);
    c.fake.currentEmail = 'ana@example.com';
    c.$('#sync-pill').click(); /* tap to reconnect */
    await tick(900);
    const descs = c.sandbox.S.entries.personal.map(e => e.desc);
    check('B7f offline edits survive the reconnect tap',
      descs.includes('Cached momo') && descs.includes('Offline chiya'), descs.join(','));
    const ups = c.fake.uploadCalls();
    check('B7f reconnect uploads instead of staying silent', ups.length >= 1, String(ups.length));
    const stored = c.fake.stores['ana@example.com'];
    const latest = stored ? JSON.parse(Object.values(stored.files)[0].content) : null;
    const upDescs = latest ? latest.entries.personal.map(e => e.desc) : [];
    check('B7f uploaded payload carries the offline edits',
      upDescs.includes('Cached momo') && upDescs.includes('Offline chiya'), upDescs.join(','));
  }

  // B7e: nothing automatic ever asks Google for a token — no silent
  // popup attempts on save, on 401, or on reconnect. The user taps instead.
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive.scheduleSave(() => drivePayloadFor('ana', ['One']));
    await tick(200);
    check('B7e save with no token makes no token request',
      c.fake.tokenRequests.length === 0,
      'reqs=' + c.fake.tokenRequests.length);
    check('B7e save with no token → Waiting to sync (not a popup)',
      Drive.getStatus() === 'reauth', Drive.getStatus());
    /* Expired token mid-session: a 401 must NOT trigger a silent retry —
     * the dead token is dropped and the tappable state is shown. */
    Drive._reset();
    Drive._setDebounceMs(30);
    c.fake.currentEmail = 'ana@example.com';
    await Drive.signIn(); /* interactive — the user's tap; works */
    const tok = c.fake.lastToken;
    check('B7e interactive sign-in still works', Drive.hasToken() === true);
    c.fake.failOnce401.add(tok); /* next Drive call: token expired */
    const reqsBefore = c.fake.tokenRequests.length;
    Drive.scheduleSave(() => drivePayloadFor('ana', ['Two']));
    await tick(400);
    check('B7e 401 triggers no silent token request',
      c.fake.tokenRequests.length === reqsBefore,
      'reqs=' + c.fake.tokenRequests.length);
    check('B7e dead token dropped after 401', Drive.hasToken() === false);
    check('B7e 401 → Waiting to sync', Drive.getStatus() === 'reauth', Drive.getStatus());
    check('B7e nothing uploaded with the dead token', c.fake.uploadCalls().length === 0);
  }

  // B7c: entry rows show date + time clearly when asked (dashboard recent list)
  {
    const c = makeContext();
    const e = { id: 'e1', ts: 1759100000000, type: 'cash_purchase', desc: 'Momo', amount: 150, party: 'Ramesh', note: '' };
    const rowDated = c.sandbox.entryRow(e, true);
    const rowPlain = c.sandbox.entryRow(e);
    const expected = c.sandbox.fmtDateTime(e.ts);
    check('B7c dated row shows full date + time',
      rowDated.includes(expected) && /class="e-dt"/.test(rowDated), rowDated);
    check('B7c plain row shows time only',
      rowPlain.includes(c.sandbox.fmtTime(e.ts)) && !rowPlain.includes(expected), rowPlain);
  }

  // B7d: pill skips redundant DOM writes (no re-animation / header shake)
  {
    const c = makeContext();
    c.sandbox.S.user = { kind: 'google', id: 'a@b.c', displayName: 'A', picture: '' };
    c.sandbox.updateSyncPill('synced');
    const pill = c.$('#sync-pill');
    check('B7d pill shows for google user', pill.hidden === false && /synced/i.test(pill.innerHTML), pill.innerHTML);
    pill.innerHTML = 'SENTINEL';
    c.sandbox.updateSyncPill('synced');
    check('B7d pill skips rewrite when nothing changed', pill.innerHTML === 'SENTINEL', pill.innerHTML);
    c.sandbox.updateSyncPill('syncing');
    check('B7d pill still updates on real change', /syncing/i.test(pill.innerHTML), pill.innerHTML);
  }

  // B8: local session survives a page reload (stays logged in)
  {
    const c1 = makeContext();
    c1.fireReady();
    await tick(100);
    c1.$('#create-username').value = 'kaza';
    c1.$('#create-password').value = 'secret1';
    c1.$('#create-password2').value = 'secret1';
    c1.sandbox.handleCreate({ preventDefault() {} });
    await tick(300);
    check('B8 local account created', c1.sandbox.S.user && c1.sandbox.S.user.kind === 'local');
    // simulate a fresh page load with the same browser storage
    const c2 = makeContext();
    Object.assign(c2.store, c1.store);
    c2.fireReady();
    await tick(200);
    check('B8 still logged in after reload', c2.$('#view-main').hidden === false);
    check('B8 same user restored',
      c2.sandbox.S.user && c2.sandbox.S.user.kind === 'local' && c2.sandbox.S.user.id === 'kaza');
    check('B8 login view not shown', c2.$('#view-login').hidden === true);
  }

  console.log('--- Part C: nicknames + analytics ---');

  // C1: local account created with a nickname → greeting uses it
  {
    const c = makeContext();
    c.fireReady();
    await tick(100);
    c.$('#create-username').value = 'kaza';
    c.$('#create-nickname').value = '  Kaji   Dai ';
    c.$('#create-password').value = 'secret1';
    c.$('#create-password2').value = 'secret1';
    c.sandbox.handleCreate({ preventDefault() {} });
    await tick(200);
    check('C1 nickname stored per account (trimmed)', JSON.parse(c.store['hisab_profile_v1_kaza']).nickname === 'Kaji Dai');
    check('C1 displayName uses nickname', c.sandbox.displayName() === 'Kaji Dai');
    c.sandbox.setNickname('');
    check('C1 empty nickname falls back to username', c.sandbox.displayName() === 'kaza');
  }

  // C2-C3: Google nickname syncs through Drive and comes back on a new device
  {
    const c = makeContext();
    c.sandbox.Drive._setDebounceMs(30);
    c.fireReady();
    await tick(100);
    c.$('#google-btn-login').click();
    await tick(500);
    c.sandbox.setNickname('Ali');
    await tick(400);
    const content = JSON.parse(Object.values(c.fake.stores['alice@gmail.com'].files)[0].content);
    check('C2 nickname included in Drive payload', content.profile && content.profile.nickname === 'Ali', JSON.stringify(content.profile));
    c.sandbox.logout();
    delete c.store['hisab_profile_v1_g_alice@gmail.com'];   // simulate a fresh device
    c.$('#google-btn-login').click();
    await tick(500);
    check('C3 nickname restored from Drive on sign-in', c.sandbox.displayName() === 'Ali', c.sandbox.displayName());
  }

  // C4: analytics buckets add up
  {
    const c = makeContext();
    c.fireReady();
    await tick(100);
    c.$('#create-username').value = 'meera';
    c.$('#create-password').value = 'secret1';
    c.$('#create-password2').value = 'secret1';
    c.sandbox.handleCreate({ preventDefault() {} });
    await tick(200);
    const now = Date.now();
    const add = (type, amount, off) => c.sandbox.addEntry({ ts: now - off * 864e5, type, desc: type, amount, party: 'P', note: '' });
    add('cash_purchase', 100, 0); add('due_purchase', 200, 1); add('money_given', 50, 2);
    add('money_taken', 70, 3); add('received_back', 30, 4); add('cash_purchase', 999, 40);
    const A = c.sandbox.analyze(c.sandbox.S.entries.personal, '30d');
    check('C4 spent = cash + due in window', A.cur.spent === 300, A.cur.spent);
    check('C4 money out = cash + gave', A.cur.out === 150, A.cur.out);
    check('C4 money in = took + got back', A.cur.in === 100, A.cur.in);
    check('C4 old entry lands in previous period', A.prev.spent === 999, A.prev.spent);
    check('C4 30 daily buckets summing to totals', A.w.buckets.length === 30 &&
      A.w.buckets.reduce((s, b) => s + b.spent, 0) === 300);
    const Y = c.sandbox.analyze(c.sandbox.S.entries.personal, '12m');
    check('C4 12 monthly buckets include all', Y.w.buckets.length === 12 &&
      Y.w.buckets.reduce((s, b) => s + b.spent, 0) === 1299);
  }

  // B9: income type — money in shows +, money out shows −
  {
    const c = makeContext();
    const sb = c.sandbox;
    const mk = (type, amount) => ({ id: 'e1', ts: Date.now(), type, desc: 'Test', amount, party: '', note: '' });
    check('B9 income type registered with income flow',
      sb.TYPES.income && sb.TYPES.income.flow === 'income' && sb.TYPE_ORDER.indexOf('income') >= 0,
      JSON.stringify(sb.TYPES.income && sb.TYPES.income.flow));
    check('B9 income counts as money in', !!(sb.IS_IN || {}).income, '');
    const rowIn = sb.entryRow(mk('income', 5000));
    check('B9 income row shows + sign', rowIn.indexOf('+ ') >= 0, rowIn.slice(-90));
    check('B9 income row uses in class', rowIn.indexOf('e-amt in') >= 0, rowIn.slice(-90));
    const rowOut = sb.entryRow(mk('cash_purchase', 500));
    check('B9 cash purchase row shows − sign', rowOut.indexOf('− ') >= 0, rowOut.slice(-90));
    check('B9 cash purchase row uses out class', rowOut.indexOf('e-amt out') >= 0, rowOut.slice(-90));
    const rowBack = sb.entryRow(mk('received_back', 1500));
    check('B9 got-money-back row shows + (money came in)', rowBack.indexOf('+ ') >= 0, rowBack.slice(-90));
    const rowDue = sb.entryRow(mk('due_purchase', 2000));
    check('B9 on-due row shows no sign (no cash moved)', rowDue.indexOf('+ ') < 0 && rowDue.indexOf('− ') < 0, rowDue.slice(-90));
    const t = sb.totalsFor([mk('income', 5000), mk('cash_purchase', 500)]);
    check('B9 totalsFor tracks income separately', t.income === 5000 && t.cash === 500,
      JSON.stringify({ income: t.income, cash: t.cash }));
    const st = sb.blankStats();
    sb.addToStats(st, mk('income', 5000));
    check('B9 income adds to money-in analytics', st.in === 5000 && st.byType.income === 5000,
      st.in + '/' + st.byType.income);
  }

  console.log('--- Part D: offline edits survive close + reopen ---');

  // B10a: an edit queued while offline persists its dirty flag in storage
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive._setDebounceMs(30);
    c.fake.currentEmail = 'ana@example.com';
    const prof = await Drive.signIn();
    Drive.writeProfile(prof);
    c.windowStub.navigator.onLine = false; /* go offline */
    Drive.scheduleSave(() => drivePayloadFor('ana', ['Offline momo']));
    await tick(100);
    check('B10a offline save persists the dirty flag',
      c.store['hisab_drive_dirty_ana@example.com'] === '1');
    check('B10a hasUnsyncedChanges true while offline', Drive.hasUnsyncedChanges() === true);
    check('B10a nothing uploaded while offline', c.fake.uploadCalls().length === 0);
    // simulate closing the app: brand-new JS context, same browser storage
    const c2 = makeContext();
    Object.assign(c2.store, c.store);
    check('B10a dirty flag survives the restart',
      c2.windowStub.Drive.hasUnsyncedChanges() === true,
      'flag=' + c2.store['hisab_drive_dirty_ana@example.com']);
  }

  // B10b: a landed upload clears the persisted flag
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive._setDebounceMs(30);
    c.fake.currentEmail = 'ana@example.com';
    const prof = await Drive.signIn();
    Drive.writeProfile(prof);
    c.windowStub.navigator.onLine = false;
    Drive.scheduleSave(() => drivePayloadFor('ana', ['Offline momo']));
    await tick(100);
    check('B10b dirty before reconnect', c.store['hisab_drive_dirty_ana@example.com'] === '1');
    /* …time passes; the token expires while the app is closed (memory is
     * wiped — the persisted dirty flag is what survives). */
    Drive._reset();
    c.windowStub.navigator.onLine = true;
    /* Back online with no token: no silent popup attempt — the tappable
     * state appears instead. The tap is the interactive sign-in. */
    const reqsBefore = c.fake.tokenRequests.length;
    Drive.scheduleSave(() => drivePayloadFor('ana', ['Offline momo']));
    await tick(100);
    check('B10b reconnect asks for no silent token',
      c.fake.tokenRequests.length === reqsBefore,
      'reqs=' + c.fake.tokenRequests.length);
    check('B10b tappable state while the token is missing',
      Drive.getStatus() === 'reauth', Drive.getStatus());
    await Drive.signIn(); /* the user's tap: interactive, popup allowed */
    Drive.scheduleSave(() => drivePayloadFor('ana', ['Offline momo']));
    await Drive.flushSave();
    await tick(100);
    check('B10b pending edit uploaded once online', c.fake.uploadCalls().length >= 1,
      String(c.fake.uploadCalls().length));
    check('B10b dirty flag cleared after the upload lands',
      c.store['hisab_drive_dirty_ana@example.com'] === undefined);
    check('B10b hasUnsyncedChanges false after sync', Drive.hasUnsyncedChanges() === false);
  }

  // B10c: full story — offline entry, app closed, reopened online:
  // the entry is still there; nothing phones Google on its own; the tap
  // uploads it to Drive.
  {
    const c1 = makeContext();
    const D1 = c1.windowStub.Drive;
    D1._setDebounceMs(30);
    c1.fake.currentEmail = 'ana@example.com';
    const prof = await D1.signIn();
    D1.writeProfile(prof);
    c1.windowStub.navigator.onLine = false; /* offline */
    D1.scheduleSave(() => drivePayloadFor('ana', ['Offline chiya']));
    await tick(100);
    c1.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'ana@example.com' });
    c1.store['hisab_data_v2_g_ana@example.com'] = JSON.stringify({ personal: [
      { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Offline chiya', amount: 80, party: '', note: '' },
    ], business: [] });

    const c2 = makeContext(); /* fresh boot, same browser storage */
    Object.assign(c2.store, c1.store);
    c2.fake.currentEmail = 'ana@example.com';
    c2.windowStub.Drive._setDebounceMs(30);
    c2.fireReady();
    c2.fireLoad(); /* a real page load fires 'load' right after DOMContentLoaded */
    await tick(1800);
    const descs = c2.sandbox.S.entries.personal.map(e => e.desc);
    check('B10c offline entry still visible after close + reopen',
      descs.includes('Offline chiya'), descs.join(','));
    check('B10c boot makes zero token requests (no silent popup)',
      c2.fake.tokenRequests.length === 0,
      JSON.stringify(c2.fake.tokenRequests));
    check('B10c nothing uploaded on boot without a tap',
      c2.fake.uploadCalls().length === 0,
      String(c2.fake.uploadCalls().length));
    check('B10c pill offers the one-tap reconnect',
      /waiting to sync/i.test(c2.$('#sync-pill').innerHTML),
      c2.$('#sync-pill').innerHTML);
    /* The tap: interactive sign-in, then the pending edit uploads. */
    c2.$('#sync-pill').click();
    await tick(1200);
    const ups = c2.fake.uploadCalls();
    check('B10c pending offline edit uploaded after the tap', ups.length >= 1, String(ups.length));
    const stored = c2.fake.stores['ana@example.com'];
    const latest = stored ? JSON.parse(Object.values(stored.files)[0].content) : null;
    const upDescs = latest ? latest.entries.personal.map(e => e.desc) : [];
    check('B10c Drive received the offline entry', upDescs.includes('Offline chiya'), upDescs.join(','));
    check('B10c dirty flag cleared after the upload lands',
      c2.store['hisab_drive_dirty_ana@example.com'] === undefined);
    check('B10c dirty flag cleared once synced',
      c2.store['hisab_drive_dirty_ana@example.com'] === undefined);
  }

  // B10g: page load triggers zero Google contact — nothing phones home or
  // opens a popup on load anymore; the pending entry uploads after the tap
  {
    const c1 = makeContext();
    const D1 = c1.windowStub.Drive;
    D1._setDebounceMs(30);
    c1.fake.currentEmail = 'ana@example.com';
    const prof = await D1.signIn();
    D1.writeProfile(prof);
    c1.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'ana@example.com' });
    c1.store['hisab_drive_dirty_ana@example.com'] = '1';
    c1.store['hisab_data_v2_g_ana@example.com'] = JSON.stringify({ personal: [
      { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Pre-load momo', amount: 80, party: '', note: '' },
    ], business: [] });

    const c2 = makeContext();
    Object.assign(c2.store, c1.store);
    c2.fake.currentEmail = 'ana@example.com';
    c2.windowStub.Drive._setDebounceMs(30);
    c2.fireReady();
    await tick(1200); /* GIS poll ran, but 'load' has NOT fired yet */
    check('B10g no token request before page load',
      c2.fake.tokenRequests.length === 0, String(c2.fake.tokenRequests.length));
    c2.fireLoad();
    await tick(1500);
    check('B10g no token request after page load either',
      c2.fake.tokenRequests.length === 0, String(c2.fake.tokenRequests.length));
    check('B10g nothing uploaded without the tap',
      c2.fake.uploadCalls().length === 0, String(c2.fake.uploadCalls().length));
    check('B10g pill offers the one-tap reconnect after load',
      /waiting to sync/i.test(c2.$('#sync-pill').innerHTML),
      c2.$('#sync-pill').innerHTML);
    c2.$('#sync-pill').click(); /* the tap: interactive sign-in, then upload */
    await tick(1500);
    check('B10g pending entry uploaded after the tap',
      c2.fake.uploadCalls().length >= 1, String(c2.fake.uploadCalls().length));
  }

  // B10h: "Sync now" is offered even with nothing pending, and pulls the
  // other device's edits from Drive (refresh alone never downloads).
  {
    const c = makeContext();
    c.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'ana@example.com' });
    c.store['hisab_google_profile'] = JSON.stringify({ email: 'ana@example.com', name: 'Ana', picture: '' });
    c.store['hisab_data_v2_g_ana@example.com'] = JSON.stringify({ personal: [
      { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Old dal', amount: 150, party: '', note: '' },
    ], business: [] });
    /* …the phone edits the entry and uploads: Drive is now newer. */
    c.fake.stores['ana@example.com'] = { files: { file1: {
      name: 'hisab-data.json',
      content: JSON.stringify({ app: 'hisab', version: 4, updatedAt: Date.now(),
        entries: { personal: [
          { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Old dal', amount: 500, party: '', note: '' },
        ], business: [] } }),
      modifiedTime: new Date().toISOString(),
    } } };
    c.fake.currentEmail = 'ana@example.com';
    c.fireReady();
    c.fireLoad();
    await tick(900);
    const before = c.sandbox.S.entries.personal[0].amount;
    check('B10h laptop still shows its own saved copy after refresh',
      before === 150, String(before));
    check('B10h refresh made zero token requests', c.fake.tokenRequests.length === 0);
    c.sandbox.openAccountMenu();
    check('B10h Sync now offered with nothing pending',
      c.$('#account-reconnect').hidden === false);
    c.$('#account-reconnect').click(); /* the tap: interactive, then pull */
    await tick(1500);
    const after = c.sandbox.S.entries.personal[0].amount;
    check('B10h Sync now pulled the phone edit from Drive',
      after === 500, String(after));
    check('B10h the pull used one interactive token request, nothing silent',
      c.fake.tokenRequests.length === 1 && c.fake.tokenRequests[0].prompt !== 'none',
      JSON.stringify(c.fake.tokenRequests));
  }

  // B11: dashboard sync button + background auto-pull.
  function seedRemoteAna(c, amount) {
    c.fake.stores['ana@example.com'] = { files: { file1: {
      name: 'hisab-data.json',
      content: JSON.stringify({ app: 'hisab', version: 4, updatedAt: Date.now(),
        entries: { personal: [
          { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Old dal', amount: amount, party: '', note: '' },
        ], business: [] } }),
      modifiedTime: new Date(Date.now() + 5000).toISOString(), /* server time, clearly newer */
    } } };
  }
  function bootGoogleAna(c) {
    c.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'ana@example.com' });
    c.store['hisab_google_profile'] = JSON.stringify({ email: 'ana@example.com', name: 'Ana', picture: '' });
    c.store['hisab_data_v2_g_ana@example.com'] = JSON.stringify({ personal: [
      { id: 'e1', ts: Date.now(), type: 'cash_purchase', desc: 'Old dal', amount: 150, party: '', note: '' },
    ], business: [] });
    c.fake.currentEmail = 'ana@example.com';
    c.fireReady();
    c.fireLoad();
    c.$('#entry-modal').hidden = true; /* the test stub defaults hidden=false; real HTML hides modals */
  }

  // B11a: the dashboard sync button is visible for Google, one tap pulls,
  // and the tap carries login_hint so Google skips the account chooser.
  {
    const c = makeContext();
    bootGoogleAna(c);
    await tick(900);
    check('B11a sync button visible for Google sessions', c.$('#sync-now-btn').hidden === false);
    seedRemoteAna(c, 800);
    c.$('#sync-now-btn').click(); /* the tap */
    await tick(1500);
    const amt = c.sandbox.S.entries.personal[0].amount;
    check('B11a one tap pulled the 800 entry', amt === 800, String(amt));
    const tr = c.fake.tokenRequests;
    check('B11a the tap sent login_hint so Google skips the chooser',
      tr.length === 1 && tr[0].hint === 'ana@example.com' && tr[0].prompt !== 'none', JSON.stringify(tr));
    check('B11a sync button hidden for device-only accounts', (function () {
      const c2 = makeContext();
      c2.fireReady(); c2.fireLoad();
      c2.$('#entry-modal').hidden = true;
      c2.sandbox.loginAs({ kind: 'local', id: 'kaza', displayName: 'kaza' }, true);
      return c2.$('#sync-now-btn').hidden === true;
    })());
  }

  // B11b: background auto-pull — no taps once the token is live.
  {
    const c = makeContext();
    bootGoogleAna(c);
    await tick(900);
    const Drive = c.windowStub.Drive;
    Drive.signIn('ana@example.com');
    await tick(800);
    check('B11b token live after one tap', Drive.hasToken() === true);
    seedRemoteAna(c, 800); /* …the phone uploads a newer snapshot… */
    const before = c.fake.tokenRequests.length;
    c.sandbox.maybeAutoPull(); /* no tap — background */
    await tick(800);
    check('B11b auto-pull brought the 800 entry with zero new token requests',
      c.sandbox.S.entries.personal[0].amount === 800 && c.fake.tokenRequests.length === before,
      c.sandbox.S.entries.personal[0].amount + '/' + c.fake.tokenRequests.length);
    c.sandbox.maybeAutoPull();
    await tick(800);
    check('B11b second auto-pull is a no-op (already seen)',
      c.sandbox.S.entries.personal[0].amount === 800);
  }

  // B11c: auto-pull never clobbers this device's own pending edits,
  // and stays out of the way while a form is open or the tab is hidden.
  {
    const c = makeContext();
    bootGoogleAna(c);
    await tick(900);
    const Drive = c.windowStub.Drive;
    Drive.signIn('ana@example.com');
    await tick(800);
    c.store['hisab_drive_dirty_ana@example.com'] = '1'; /* local edits pending */
    seedRemoteAna(c, 800);
    c.sandbox.maybeAutoPull();
    await tick(800);
    check('B11c auto-pull skipped while local edits are pending',
      c.sandbox.S.entries.personal[0].amount === 150,
      String(c.sandbox.S.entries.personal[0].amount));
    delete c.store['hisab_drive_dirty_ana@example.com'];
    c.$('#entry-modal').hidden = false; /* form open */
    c.sandbox.maybeAutoPull();
    await tick(800);
    check('B11c auto-pull skipped while the entry form is open',
      c.sandbox.S.entries.personal[0].amount === 150);
    c.$('#entry-modal').hidden = true;
    c.documentStub.visibilityState = 'hidden'; /* tab in background */
    c.sandbox.maybeAutoPull();
    await tick(800);
    check('B11c auto-pull skipped while the tab is hidden',
      c.sandbox.S.entries.personal[0].amount === 150);
    c.documentStub.visibilityState = 'visible';
    c.sandbox.maybeAutoPull();
    await tick(800);
    check('B11c auto-pull applies once the way is clear',
      c.sandbox.S.entries.personal[0].amount === 800,
      String(c.sandbox.S.entries.personal[0].amount));
  }

  // B11d: account menu "Sync now" also skips the chooser.
  {
    const c = makeContext();
    bootGoogleAna(c);
    await tick(900);
    c.sandbox.openAccountMenu();
    c.$('#account-reconnect').click();
    await tick(1500);
    const tr = c.fake.tokenRequests;
    check('B11d account Sync now sent login_hint',
      tr.length === 1 && tr[0].hint === 'ana@example.com', JSON.stringify(tr));
  }

  // B10d: the account modal shows an honest offline-readiness line
  {
    const c = makeContext();
    c.sandbox.updateOfflineLine();
    check('B10d offline line honest when SW unsupported',
      /not supported/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
    c.windowStub.navigator.serviceWorker = {
      getRegistration: async () => ({ active: { state: 'activated' } }),
      controller: { state: 'activated' }, /* this page load is SW-controlled */
    };
    c.sandbox.updateOfflineLine();
    await tick(50);
    check('B10d offline line shows ready when a worker is active and controlling',
      /ready ✓/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
    c.windowStub.navigator.serviceWorker = {
      getRegistration: async () => ({ active: { state: 'activated' } }),
      controller: null, /* installed, but this load isn't controlled yet */
    };
    c.sandbox.updateOfflineLine();
    await tick(50);
    check('B10d offline line says almost-ready when installed but not controlling',
      /almost ready/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
    c.windowStub.navigator.serviceWorker = { getRegistration: async () => null };
    c.sandbox.updateOfflineLine();
    await tick(50);
    check('B10d offline line asks for one more online open when missing',
      /not ready yet/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
  }

  // B10e: the line never gets stuck on "checking…" when the registry is quiet
  {
    const c = makeContext();
    let hang = true;
    c.windowStub.navigator.serviceWorker = {
      getRegistration: () => hang
        ? new Promise(function () {})                       // never settles: slow/stuck installer
        : Promise.resolve({ active: { state: 'activated' } }),
      register: async () => ({ installing: { state: 'installing' } }),
      controller: { state: 'activated' },
    };
    c.sandbox.updateOfflineLine({ nudgeDelay: 30, recheckDelay: 30, deadlineDelay: 60 });
    await tick(15);
    check('B10e shows checking first',
      /checking/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
    await tick(40); // past the nudge delay
    check('B10e nudges the installer instead of hanging',
      /still setting up/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
    hang = false; // registry answers again on the re-check
    await tick(80);
    check('B10e recovers to ready once the registry answers',
      /ready ✓/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
  }

  // B10f: even if the registry never answers, the line lands honestly
  {
    const c = makeContext();
    c.windowStub.navigator.serviceWorker = {
      getRegistration: () => new Promise(function () {}),
      register: async () => { throw new Error('denied'); },
    };
    c.sandbox.updateOfflineLine({ nudgeDelay: 30, recheckDelay: 30, deadlineDelay: 60 });
    await tick(200);
    check('B10f lands on not-ready instead of hanging forever',
      /not ready yet/.test(c.$('#offline-ready').textContent), c.$('#offline-ready').textContent);
  }

  console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
