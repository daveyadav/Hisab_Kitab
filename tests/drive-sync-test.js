/* Hisab Google Drive sync — smoke tests with a MOCKED Google backend.
 * Part A: js/drive.js unit tests (mocked GIS token client + fake Drive API).
 * Part B: js/app.js integration (DOM-stubbed, real drive.js, mocked Google).
 *
 * Covers: uiState for missing client ID / missing GIS / offline,
 * Google sign-in → profile, loadRemote empty/existing, debounced save
 * roundtrip, per-email isolation, 401 → silent re-auth → retry,
 * re-auth failure → 'reauth' status, signOut, local accounts untouched
 * by Drive, Google↔local account isolation, "Continue as" one-tap with
 * no auto-popup on boot.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const { webcrypto } = require('crypto');
const JS = '/home/hatch/workspace/hisab-github/js';

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
  const windowStub = {
    localStorage,
    navigator: { onLine: online },
    addEventListener() {}, removeEventListener() {}, scrollTo() {},
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

  // A9: 401 → silent re-auth → retry succeeds
  {
    const c = makeContext();
    const Drive = c.windowStub.Drive;
    Drive._setDebounceMs(30);
    await Drive.signIn(); // tok-1
    Drive.scheduleSave(() => drivePayloadFor('alice', ['First']));
    await tick(300);
    const log = [];
    Drive.onStatus(s => log.push(s));
    const reqsBefore = c.fake.tokenRequests.length;
    c.fake.failOnce401.add(c.fake.lastToken);
    Drive.scheduleSave(() => drivePayloadFor('alice', ['Second']));
    await tick(600);
    check('A9 401 triggers one silent re-auth', c.fake.tokenRequests.length === reqsBefore + 1,
      'requests: ' + c.fake.tokenRequests.length + ' vs ' + (reqsBefore + 1));
    check('A9 status recovers to synced after retry', Drive.getStatus() === 'synced', Drive.getStatus());
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

  // B7: boot with google session → "Continue as" shown, no auto-popup
  {
    const c = makeContext();
    c.store['hisab_session_v2'] = JSON.stringify({ kind: 'google', id: 'alice@gmail.com' });
    c.store['hisab_google_profile'] = JSON.stringify({ email: 'alice@gmail.com', name: 'Alice', picture: '' });
    c.fireReady();
    await tick(200);
    check('B7 continue-as offered on boot', c.$('#continue-as-wrap').hidden === false);
    check('B7 continue-as shows the email', /alice@gmail\.com/.test(c.$('#continue-as-btn').innerHTML));
    check('B7 main view NOT auto-opened', c.$('#view-main').hidden === true);
    check('B7 no token request without user gesture', c.fake.tokenRequests.length === 0);
    // clicking it completes sign-in
    c.$('#continue-as-btn').click();
    await tick(500);
    check('B7 continue-as click signs in', c.$('#view-main').hidden === false &&
      c.sandbox.S.user && c.sandbox.S.user.kind === 'google');
  }

  console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
