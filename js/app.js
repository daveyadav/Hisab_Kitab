/* =========================================================================
 * Hisab — a calm khata (ledger) book.
 *
 * Pure static app: HTML + CSS + vanilla JS. The only external dependency
 * is Google Identity Services (accounts.google.com), loaded for the
 * optional "Sign in with Google" flow — everything else works offline.
 *
 * Two account kinds, fully isolated from each other:
 *   - local  : username + password, lives only in this browser
 *              (device-only, offline-capable)
 *   - google : signed in with a Gmail address; records are ALSO kept in
 *              a hidden app folder in the user's own Google Drive
 *              (js/drive.js), so signing in on any browser/phone loads
 *              the same data. Needs internet to sync.
 *
 * SECURITY NOTE: local logins are salted SHA-256 (WebCrypto when
 * available) and are family-convenience locks, NOT bank-grade security.
 * Google accounts rely on Google's own sign-in; the app only ever sees
 * the files it created inside the user's private Drive app folder.
 * ========================================================================= */
'use strict';

/* ---------------- constants ---------------- */
var TZ = 'Asia/Kathmandu';
/* Self-service accounts.
 * Local accounts (per-device):
 *  hisab_accounts_v2            = { lowercasedName: {name, salt, algo, passHash, createdAt} }
 * Google accounts: no password record here — identity comes from Google;
 *  hisab_google_profile         = { email, name, picture } (for "Continue as …")
 * Per-account records (both kinds):
 *  hisab_data_v2_<key>         = { personal: [...], business: [...] }
 *    where <key> is the lowercased username, or 'g_' + lowercased Gmail.
 *    (For Google accounts this doubles as the offline cache of Drive.)
 * Session:
 *  hisab_session_v2             = { kind: 'local'|'google', id: <key> }
 *    (older installs stored a bare username string — still honoured)     */
var LS_ACCOUNTS = 'hisab_accounts_v2';
var LS_SESSION  = 'hisab_session_v2';
function accountStoreKey() {
  if (S.user.kind === 'google') return 'g_' + S.user.id;
  return S.user.id;
}
function lsDataKey(name) { return 'hisab_data_v2_' + String(name || '').trim().toLowerCase(); }

/* Entry types. `flow` drives totals and balances:
 *  - cash: money left my hand right now (purchase paid in cash)
 *  - payable+: I now owe more (bought on due / took money)
 *  - payable-: I paid some of what I owed
 *  - receivable+: someone now owes me (I gave/lent money)
 *  - receivable-: someone paid me back                                     */
var TYPES = {
  cash_purchase:  { label: 'Cash purchase',  short: 'Cash',      partyLabel: 'Shop / vendor (optional)', flow: 'cash',        icon: 'cart'    },
  due_purchase:   { label: 'Bought on due',  short: 'On due',    partyLabel: 'Shop / vendor',            flow: 'payable+',    icon: 'receipt' },
  money_given:    { label: 'Gave money',     short: 'Gave',      partyLabel: 'Person',                   flow: 'receivable+', icon: 'up'      },
  money_taken:    { label: 'Took money',     short: 'Took',      partyLabel: 'Person',                   flow: 'payable+',    icon: 'down'    },
  paid_back:      { label: 'I paid back',    short: 'Paid back', partyLabel: 'Person / vendor',          flow: 'payable-',    icon: 'check'   },
  received_back:  { label: 'Got money back', short: 'Got back',  partyLabel: 'Person',                   flow: 'receivable-', icon: 'inbox'   }
};
var TYPE_ORDER = ['cash_purchase', 'due_purchase', 'money_given', 'money_taken', 'paid_back', 'received_back'];

/* ---------------- tiny DOM helpers ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function uid() {
  return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------------- inline SVG icons ---------------- */
var ICONS = {
  home:    '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  list:    '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  swap:    '<path d="M7 8l-4 4 4 4"/><path d="M3 12h13"/><path d="M17 8l4 4-4 4"/><path d="M21 12H8"/>',
  dots:    '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  plus:    '<path d="M12 5v14M5 12h14"/>',
  search:  '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  pencil:  '<path d="M17 3l4 4L8 20l-5 1 1-5z"/>',
  trash:   '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/>',
  download:'<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  upload:  '<path d="M12 15V4"/><path d="M7 8l5-5 5 5"/><path d="M4 20h16"/>',
  users:   '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.6c2 .9 3 2.9 3 5.4"/>',
  logout:  '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  x:       '<path d="M6 6l12 12M18 6L6 18"/>',
  check:   '<path d="M4 12.5l5 5L20 6.5"/>',
  cart:    '<path d="M3 4h2l2.4 11.2h10.9L21 8H7"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>',
  receipt: '<path d="M6 3h12v18l-2-1.6-2 1.6-2-1.6L10 21l-2-1.6L6 21z"/><path d="M9 8h6M9 12h6"/>',
  up:      '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  down:    '<path d="M12 5v14"/><path d="M5 12l7 7 7-7"/>',
  inbox:   '<path d="M3 13l2.7-7.5h12.6L21 13v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h6l1.6 2.6h2.8L15 13h6"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  shield:  '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  book:    '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>'
};
function icon(name, cls) {
  return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
}

/* ---------------- storage ---------------- */
function loadJSON(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { toast('Could not save — storage is unavailable.'); return false; }
}

/* ---------------- password hashing ----------------
 * Salted SHA-256 via WebCrypto when available (secure contexts:
 * https, localhost, and file:// in modern browsers). On pages where
 * SubtleCrypto is unavailable we fall back to a salted cyrb53 hash —
 * weaker, but the whole login is device-local family convenience,
 * never a security boundary. */
function makeSalt() {
  try {
    if (typeof window !== 'undefined' && window.crypto && typeof crypto.getRandomValues === 'function') {
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }
  } catch (e) {}
  return 's' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function cyrb53(str, seed) {
  var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}
function hashPassword(password, salt) {
  var input = salt + '::' + password;
  try {
    if (window.crypto && crypto.subtle && window.isSecureContext !== false) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)).then(function (buf) {
        return { algo: 'sha256', hash: Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('') };
      }).catch(function () {
        return { algo: 'cyrb53', hash: cyrb53(input, 7) };
      });
    }
  } catch (e) {}
  return Promise.resolve({ algo: 'cyrb53', hash: cyrb53(input, 7) });
}

/* ---------------- Kathmandu date/time + NPR formatting ---------------- */
var _dtfDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
var _dtfTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
var _dtfParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

function tzParts(ts) {
  var o = {};
  _dtfParts.formatToParts(ts).forEach(function (p) { o[p.type] = p.value; });
  return o; // {year, month, day, hour, minute}
}
function dateKey(ts) { var p = tzParts(ts); return p.year + '-' + p.month + '-' + p.day; }
function monthKey(ts) { var p = tzParts(ts); return p.year + '-' + p.month; }
function fmtDate(ts) { return _dtfDate.format(ts); }          // "Sun, 28 Sept 2026"
function fmtTime(ts) { return _dtfTime.format(ts); }          // "3:50 PM"
function fmtDateTime(ts) { return fmtDate(ts) + ' · ' + fmtTime(ts); }
function todayKey() { return dateKey(Date.now()); }
function thisMonthKey() { return monthKey(Date.now()); }

/* Value for <input type="datetime-local"> — Kathmandu wall-clock time. */
function inputNow() {
  var p = tzParts(Date.now());
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
}
/* Parse a datetime-local value as Kathmandu wall-clock -> epoch ms. */
function tsFromInput(v) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v || '');
  if (!m) return Date.now();
  var Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5];
  var target = Date.UTC(Y, Mo - 1, D, H, Mi);
  var guess = target;
  for (var i = 0; i < 3; i++) {
    var p = tzParts(guess);
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += (target - asUtc);
  }
  return guess;
}
/* Nepal uses lakh/crore grouping: 1,25,000 — en-IN matches. */
function fmtRs(n) {
  var v = Math.round(Number(n) || 0);
  return 'Rs ' + v.toLocaleString('en-IN');
}

/* ---------------- app state ---------------- */
var S = {
  user: null,            // { kind:'local'|'google', id, displayName, picture }
  portal: 'personal',    // 'personal' | 'business'
  tab: 'dashboard',
  entries: { personal: [], business: [] },
  filterQ: '',
  filterType: 'all',
  editingId: null,       // entry id being edited (null = new)
  entryType: 'cash_purchase'
};

function dataKey() { return 'hisab_data_v2_' + accountStoreKey(); }
function displayName() { return S.user ? S.user.displayName : ''; }
/* Human label for the signed-in account: Gmail for Google, username for local. */
function accountLabel() {
  if (!S.user) return 'unknown';
  return S.user.kind === 'google' ? S.user.id : S.user.displayName;
}
function blankEntries() { return { personal: [], business: [] }; }
function portalEntries() { return S.entries[S.portal] || []; }
function setPortalEntries(list) {
  S.entries[S.portal] = list;
  saveJSON(dataKey(), S.entries);
  /* Google accounts: queue an upload to Drive (debounced, 2s). */
  if (S.user && S.user.kind === 'google' && typeof Drive !== 'undefined') {
    Drive.scheduleSave(drivePayload);
  }
}
/* Snapshot uploaded to Drive on every mutation (last write wins). */
function drivePayload() {
  return { app: 'hisab', version: 3, updatedAt: Date.now(), entries: S.entries };
}
function validEntriesShape(e) {
  return !!(e && Array.isArray(e.personal) && Array.isArray(e.business));
}

/* ---------------- toast + confirm ---------------- */
var _toastTimer = null;
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
}
var _confirmCb = null;
function confirmDlg(title, text, yesLabel, cb) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yesLabel || 'Confirm';
  _confirmCb = cb;
  $('#confirm-modal').hidden = false;
}

/* ---------------- accounts & session (self-service, per-device) ---------------- */
function getAccounts() { return loadJSON(LS_ACCOUNTS, {}); }
function saveAccounts(a) { return saveJSON(LS_ACCOUNTS, a); }
function findAccount(name) {
  var key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  var accounts = getAccounts();
  return accounts[key] || null;
}

function showView(name) {
  ['login', 'create', 'main'].forEach(function (v) { $('#view-' + v).hidden = (v !== name); });
  window.scrollTo(0, 0);
}

function localUserFrom(account) {
  return { kind: 'local', id: account.name.toLowerCase(), displayName: account.name, picture: '' };
}

function boot() {
  // static brand marks + nav icons
  $('#create-mark').innerHTML = icon('book');
  $('#login-mark').innerHTML = icon('book');
  $('#main-mark').innerHTML = icon('book');
  $('#fab').innerHTML = icon('plus');
  $('#entry-close').innerHTML = icon('x');
  $('#account-close').innerHTML = icon('x');
  var navIcons = { dashboard: 'home', entries: 'list', balances: 'swap', more: 'dots' };
  $all('.nav-btn').forEach(function (b) {
    $('.nav-ico', b).innerHTML = icon(navIcons[b.dataset.tab]);
  });

  // Google sync UI (degrades gracefully when unavailable)
  if (typeof Drive !== 'undefined') {
    Drive.onStatus(updateSyncPill);
    renderGoogleButtons();
    /* Google's script loads async — re-check until it arrives or gives up. */
    var tries = 0, lastState = Drive.uiState();
    var timer = setInterval(function () {
      var st = Drive.uiState();
      if (st !== lastState) { lastState = st; renderGoogleButtons(); }
      if (++tries > 20 || st === 'ready' || st === 'no-client-id') clearInterval(timer);
    }, 500);
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('load', function () { setTimeout(renderGoogleButtons, 600); });
    }
  }

  // restore the signed-in account, if any
  var sess = loadJSON(LS_SESSION, null);
  var account = null;
  if (typeof sess === 'string') account = findAccount(sess);            // older installs
  else if (sess && sess.kind === 'local') account = findAccount(sess.id);
  if (account) { loginAs(localUserFrom(account)); return; }

  if (sess && sess.kind === 'google' && typeof Drive !== 'undefined') {
    /* Last time was a Google account: offer one-tap continue, but never
     * auto-popup — the token flow needs a real user gesture. */
    var prof = Drive.readProfile();
    if (prof && prof.email) showContinueAs(prof);
  }
  showView('login');
}

function loginAs(user) {
  S.user = user;
  S.portal = 'personal';
  S.tab = 'dashboard';
  S.filterQ = ''; S.filterType = 'all'; S.editingId = null;
  S.entries = loadJSON(dataKey(), blankEntries());
  if (!Array.isArray(S.entries.personal)) S.entries.personal = [];
  if (!Array.isArray(S.entries.business)) S.entries.business = [];
  saveJSON(LS_SESSION, { kind: user.kind, id: user.id });
  hideContinueAs();
  showView('main');
  renderAll();
  updateSyncPill(typeof Drive !== 'undefined' ? Drive.getStatus() : 'disabled');
  toast('Namaste, ' + user.displayName);
}

function logout() {
  if (S.user && S.user.kind === 'google' && typeof Drive !== 'undefined') Drive.signOut();
  try { localStorage.removeItem(LS_SESSION); } catch (e) {}
  S.user = null;
  $('#login-username').value = '';
  $('#login-password').value = '';
  $('#login-error').hidden = true;
  renderGoogleButtons();
  showView('login');
}

/* ---- create account (self-service) ---- */
function handleCreate(e) {
  e.preventDefault();
  var name = $('#create-username').value.trim();
  var p1 = $('#create-password').value, p2 = $('#create-password2').value;
  var err = $('#create-error');
  if (name.length < 3) { err.textContent = 'Username needs at least 3 characters.'; err.hidden = false; return; }
  if (p1.length < 4) { err.textContent = 'Password needs at least 4 characters.'; err.hidden = false; return; }
  if (p1 !== p2) { err.textContent = 'Passwords do not match.'; err.hidden = false; return; }
  var key = name.toLowerCase();
  if (getAccounts()[key]) { err.textContent = 'Username taken.'; err.hidden = false; return; }
  var salt = makeSalt();
  hashPassword(p1, salt).then(function (h) {
    var accounts = getAccounts();
    if (accounts[key]) { err.textContent = 'Username taken.'; err.hidden = false; return; }
    var account = { name: name, salt: salt, algo: h.algo, passHash: h.hash, createdAt: Date.now() };
    accounts[key] = account;
    saveAccounts(accounts);
    err.hidden = true;
    $('#create-form').reset();
    loginAs(localUserFrom(account));   // signed straight in
  });
}

/* ---- login ---- */
function handleLogin(e) {
  e.preventDefault();
  var name = $('#login-username').value.trim();
  var pw = $('#login-password').value;
  var err = $('#login-error');
  var account = findAccount(name);
  if (!account) { err.textContent = 'No such account on this device.'; err.hidden = false; return; }
  hashPassword(pw, account.salt).then(function (h) {
    if (h.hash === account.passHash) { err.hidden = true; loginAs(localUserFrom(account)); }
    else { err.textContent = 'Wrong password.'; err.hidden = false; }
  });
}

/* ---- account menu (switch / log out) ---- */
function openAccountMenu() {
  if (!S.user) return;
  $('#account-name').textContent = S.user.displayName;
  var av = $('#account-avatar');
  if (S.user.picture) av.innerHTML = '<img src="' + esc(S.user.picture) + '" alt="">';
  else av.textContent = S.user.displayName.charAt(0).toUpperCase();
  $('#account-sub').textContent = S.user.kind === 'google'
    ? S.user.id + ' · synced via Google Drive'
    : 'Device-only account · this phone only';
  var rc = $('#account-reconnect');
  if (rc) rc.hidden = !(S.user.kind === 'google' && typeof Drive !== 'undefined' && Drive.getStatus() === 'reauth');
  $('#account-modal').hidden = false;
}
function closeAccountMenu() { $('#account-modal').hidden = true; }

/* ---------------- Google sign-in ---------------- */

function googleWhyNot(st) {
  if (st === 'no-client-id') return 'Google sync is not set up yet — the owner must add a Client ID in js/config.js (see README).';
  if (st === 'needs-internet') return 'Google sign-in needs an internet connection.';
  if (st === 'loading-gis') return 'Loading Google sign-in…';
  return 'Google sign-in is unavailable right now.';
}

/* Render the Google buttons on both auth views according to availability. */
function renderGoogleButtons() {
  if (typeof Drive === 'undefined') return;
  var st = Drive.uiState();
  var pairs = [
    ['#google-btn-login', '#google-sub-login', '#google-note-login'],
    ['#google-btn-create', '#google-sub-create', '#google-note-create']
  ];
  pairs.forEach(function (p) {
    var btn = $(p[0]), sub = $(p[1]), note = $(p[2]);
    if (!btn) return;
    var ready = (st === 'ready');
    btn.disabled = !ready;
    if (sub) sub.textContent = ready ? 'Syncs across your devices' : googleWhyNot(st);
    if (note) {
      if (st === 'no-client-id') { note.textContent = googleWhyNot(st); note.hidden = false; }
      else note.hidden = true;
    }
  });
}

function setGoogleBusy(busy) {
  ['#google-btn-login', '#google-btn-create', '#continue-as-btn'].forEach(function (sel) {
    var b = $(sel);
    if (b) b.disabled = !!busy;
  });
}

/* One-tap "Continue as <email>" shown when the last session was Google. */
function showContinueAs(prof) {
  var wrap = $('#continue-as-wrap'), btn = $('#continue-as-btn');
  if (!wrap || !btn) return;
  btn.innerHTML =
    (prof.picture ? '<img class="g-avatar" src="' + esc(prof.picture) + '" alt="">' : '') +
    '<span class="g-text"><span class="g-title">Continue as ' + esc(prof.name || prof.email) + '</span>' +
    '<span class="g-sub">' + esc(prof.email) + '</span></span>';
  wrap.hidden = false;
}
function hideContinueAs() {
  var wrap = $('#continue-as-wrap');
  if (wrap) wrap.hidden = true;
}

/* Full Google sign-in flow: token → profile → load Drive records → enter. */
function googleSignInFlow(hint) {
  if (typeof Drive === 'undefined' || Drive.uiState() !== 'ready') {
    toast(googleWhyNot(typeof Drive === 'undefined' ? 'no-client-id' : Drive.uiState()));
    return;
  }
  setGoogleBusy(true);
  Drive.signIn(hint).then(function (profile) {
    if (!profile || !profile.email) throw new Error('no-email');
    return Drive.loadRemote().then(function (remote) {
      var user = {
        kind: 'google',
        id: profile.email.toLowerCase(),
        displayName: profile.name || profile.email,
        picture: profile.picture || ''
      };
      /* Prime the local copy (offline cache) before logging in. */
      S.user = user;
      var entries = (remote && validEntriesShape(remote.entries)) ? remote.entries : blankEntries();
      saveJSON(dataKey(), entries);
      Drive.writeProfile(profile);
      loginAs(user);
      Drive.markInSync();
      updateSyncPill(Drive.getStatus());
      toast(remote ? 'Signed in — synced from your Drive.' : 'Signed in with Google — fresh khata ready.');
    });
  }).catch(function () {
    toast('Google sign-in didn\'t complete. You can use a device-only account instead.');
  }).then(function () {
    setGoogleBusy(false);
    renderGoogleButtons();
  });
}

/* Sync-status pill in the top bar (Google accounts only). */
function updateSyncPill(s) {
  var pill = $('#sync-pill');
  if (!pill) return;
  if (!S.user || S.user.kind !== 'google' || s === 'disabled') { pill.hidden = true; pill.onclick = null; return; }
  var map = {
    synced:  ['Synced ✓', 'ok'],
    syncing: ['Syncing…', 'busy'],
    offline: ['Offline — will sync', 'warn'],
    reauth:  ['Tap to reconnect', 'bad'],
    error:   ['Sync error — will retry', 'bad'],
    idle:    ['Ready', '']
  };
  var m = map[s] || map.idle;
  pill.hidden = false;
  pill.innerHTML = '<span class="dot"></span>' + esc(m[0]);
  pill.className = 'sync-pill ' + m[1];
  pill.onclick = (s === 'reauth') ? function () { googleSignInFlow(); } : null;
}

/* ---------------- entries ---------------- */
function addEntry(data) {
  var list = portalEntries();
  list.push({
    id: uid(), ts: data.ts, type: data.type,
    desc: data.desc, amount: Math.round(Math.abs(Number(data.amount) || 0)),
    party: (data.party || '').trim(), note: (data.note || '').trim()
  });
  setPortalEntries(list);
}
function updateEntry(id, data) {
  var list = portalEntries();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list[i].ts = data.ts; list[i].type = data.type;
      list[i].desc = data.desc; list[i].amount = Math.round(Math.abs(Number(data.amount) || 0));
      list[i].party = (data.party || '').trim(); list[i].note = (data.note || '').trim();
      break;
    }
  }
  setPortalEntries(list);
}
function deleteEntry(id) {
  setPortalEntries(portalEntries().filter(function (e) { return e.id !== id; }));
}
function getEntry(id) {
  var list = portalEntries();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/* ---------------- balances ----------------
 * Per person/vendor: how much I owe them (payable) and how much they owe
 * me (receivable). Only exact name matches are grouped — keep names
 * consistent (e.g. always "Ramesh") for clean totals. */
function computeBalances(list) {
  var map = {};
  list.forEach(function (e) {
    if (!e.party) return;
    var b = map[e.party] || (map[e.party] = { party: e.party, payable: 0, receivable: 0, count: 0 });
    b.count++;
    var f = TYPES[e.type] ? TYPES[e.type].flow : 'cash';
    if (f === 'payable+') b.payable += e.amount;
    else if (f === 'payable-') b.payable -= e.amount;
    else if (f === 'receivable+') b.receivable += e.amount;
    else if (f === 'receivable-') b.receivable -= e.amount;
  });
  return map;
}
function totalsFor(list) {
  var t = { cash: 0, payable: 0, receivable: 0, paidBack: 0, receivedBack: 0, count: list.length, gross: 0 };
  list.forEach(function (e) {
    t.gross += e.amount;
    var f = TYPES[e.type] ? TYPES[e.type].flow : 'cash';
    if (f === 'cash') t.cash += e.amount;
    else if (f === 'payable+') t.payable += e.amount;
    else if (f === 'payable-') t.paidBack += e.amount;
    else if (f === 'receivable+') t.receivable += e.amount;
    else if (f === 'receivable-') t.receivedBack += e.amount;
  });
  return t;
}
function netOutstanding(list) {
  var b = computeBalances(list), owe = 0, owed = 0;
  Object.keys(b).forEach(function (k) { owe += b[k].payable; owed += b[k].receivable; });
  return { owe: owe, owed: owed };
}

/* ---------------- rendering ---------------- */
function renderAll() {
  if (!S.user) return;
  renderHeader();
  $all('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === S.tab); });
  ['dashboard', 'entries', 'balances', 'more'].forEach(function (t) { $('#tab-' + t).hidden = (t !== S.tab); });
  if (S.tab === 'dashboard') renderDashboard();
  else if (S.tab === 'entries') renderEntries();
  else if (S.tab === 'balances') renderBalances();
  else renderMore();
}

function renderHeader() {
  $('#portal-personal').classList.toggle('active', S.portal === 'personal');
  $('#portal-business').classList.toggle('active', S.portal === 'business');
  var chip = $('#user-chip');
  if (S.user.picture) chip.innerHTML = '<img class="chip-avatar" src="' + esc(S.user.picture) + '" alt="">' + '<span>' + esc(S.user.displayName) + '</span>';
  else chip.innerHTML = icon('users') + '<span>' + esc(S.user.displayName) + '</span>';
}

function statCard(label, value, cls) {
  return '<div class="stat ' + (cls || '') + '"><div class="k">' + esc(label) + '</div><div class="v ' + (cls === 'neg' ? 'neg' : cls === 'pos' ? 'pos' : '') + '">' + value + '</div></div>';
}

function entryRow(e) {
  var t = TYPES[e.type] || TYPES.cash_purchase;
  var f = t.flow;
  var amtCls = (f === 'receivable+' || f === 'receivable-') ? 'in' : (f === 'cash' || f === 'payable+' ? 'out' : '');
  var sign = (f === 'payable-' || f === 'receivable-') ? '− ' : (f === 'cash' || f === 'payable+' || f === 'receivable+') ? '' : '';
  var sub = fmtTime(e.ts) + (e.party ? ' · ' + esc(e.party) : '') + ' · ' + esc(t.short);
  return '<button class="entry-row" data-id="' + e.id + '">' +
    '<span class="e-ico t-' + e.type + '">' + icon(t.icon) + '</span>' +
    '<span class="e-main"><span class="e-desc">' + esc(e.desc) + '</span><br>' +
    '<span class="e-sub">' + sub + '</span></span>' +
    '<span class="e-amt ' + amtCls + '">' + sign + fmtRs(e.amount) + '</span></button>';
}

/* ---- dashboard ---- */
function renderDashboard() {
  var list = portalEntries();
  var tk = todayKey(), mk = thisMonthKey();
  var todayList = list.filter(function (e) { return dateKey(e.ts) === tk; });
  var monthList = list.filter(function (e) { return monthKey(e.ts) === mk; });
  var tt = totalsFor(todayList), mt = totalsFor(monthList);
  var net = netOutstanding(list);
  var portalName = S.portal === 'personal' ? 'Personal' : 'Business';

  var recent = list.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 5);

  $('#tab-dashboard').innerHTML =
    '<div class="greet"><h2>Namaste, ' + esc(S.user.displayName) + '</h2>' +
    '<p class="muted">' + esc(portalName) + ' khata · ' + esc(fmtDate(Date.now())) + '</p></div>' +
    '<div class="stat-grid">' +
      statCard("Today's cash out", fmtRs(tt.cash)) +
      statCard("Today's new dues", fmtRs(tt.payable)) +
      '<div class="stat"><div class="k">I owe (total)</div><div class="v neg">' + fmtRs(net.owe) + '</div></div>' +
      '<div class="stat"><div class="k">Owed to me (total)</div><div class="v pos">' + fmtRs(net.owed) + '</div></div>' +
    '</div>' +
    '<div class="section-title">This month</div>' +
    '<div class="card menu-card">' +
      '<div class="user-row"><span class="e-ico t-cash_purchase">' + icon('cart') + '</span><div class="e-main"><div class="e-desc">Cash purchases</div></div><div class="bal">' + fmtRs(mt.cash) + '</div></div>' +
      '<div class="user-row"><span class="e-ico t-due_purchase">' + icon('receipt') + '</span><div class="e-main"><div class="e-desc">Bought on due</div></div><div class="bal">' + fmtRs(mt.payable) + '</div></div>' +
      '<div class="user-row"><span class="e-ico t-money_given">' + icon('up') + '</span><div class="e-main"><div class="e-desc">Money given</div></div><div class="bal">' + fmtRs(mt.receivable) + '</div></div>' +
    '</div>' +
    '<div class="section-title">Recent entries</div>' +
    (recent.length
      ? '<div>' + recent.map(entryRow).join('') + '</div>'
      : '<div class="card empty">' + icon('book') + '<p>No entries yet.<br>Tap + to record your first one.</p></div>') +
    '<button class="btn ghost block" id="dash-all">View all entries</button>';

  $('#dash-all').addEventListener('click', function () { S.tab = 'entries'; renderAll(); });
  $all('#tab-dashboard .entry-row').forEach(function (r) {
    r.addEventListener('click', function () { openEntryModal(r.dataset.id); });
  });
}

/* ---- entries list ---- */
function filteredEntries() {
  var q = S.filterQ.trim().toLowerCase();
  return portalEntries().filter(function (e) {
    if (S.filterType !== 'all' && e.type !== S.filterType) return false;
    if (q && (e.desc || '').toLowerCase().indexOf(q) === -1 &&
        (e.party || '').toLowerCase().indexOf(q) === -1 &&
        (e.note || '').toLowerCase().indexOf(q) === -1) return false;
    return true;
  }).sort(function (a, b) { return b.ts - a.ts; });
}

function renderEntries() {
  var list = filteredEntries();
  var t = totalsFor(list);

  var chips = '<button class="chip' + (S.filterType === 'all' ? ' active' : '') + '" data-f="all">All</button>' +
    TYPE_ORDER.map(function (k) {
      return '<button class="chip' + (S.filterType === k ? ' active' : '') + '" data-f="' + k + '">' + esc(TYPES[k].short) + '</button>';
    }).join('');

  var groups = {}, order = [];
  list.forEach(function (e) {
    var k = dateKey(e.ts);
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(e);
  });

  var html = '<div class="toolbar"><div class="search-row"><div class="grow">' +
    '<span class="search-ico">' + icon('search') + '</span>' +
    '<input id="entries-search" type="search" placeholder="Search items, people, notes…" value="' + esc(S.filterQ) + '"></div></div>' +
    '<div class="chip-row">' + chips + '</div></div>' +
    '<div class="summary-line"><span class="muted">' + list.length + ' entr' + (list.length === 1 ? 'y' : 'ies') + '</span>' +
    '<span class="total">Total ' + fmtRs(t.gross) + '</span></div>';

  if (!list.length) {
    html += '<div class="card empty">' + icon('search') + '<p>Nothing found.<br>Try a different search or filter.</p></div>';
  } else {
    order.forEach(function (k) {
      var day = groups[k];
      var dt = totalsFor(day);
      html += '<div class="day-group"><div class="day-head"><span class="d">' + esc(fmtDate(day[0].ts)) + '</span>' +
        '<span class="t">' + fmtRs(dt.gross) + '</span></div>' +
        day.map(entryRow).join('') + '</div>';
    });
  }
  $('#tab-entries').innerHTML = html;

  var search = $('#entries-search');
  // Re-rendering rebuilds the input, so restore focus + caret after each keystroke.
  search.addEventListener('input', function () {
    S.filterQ = search.value;
    var pos = null;
    try { pos = search.selectionStart; } catch (e) {}
    renderEntries();
    var s2 = $('#entries-search');
    s2.focus();
    try { if (pos !== null) s2.setSelectionRange(pos, pos); } catch (e) {}
  });
  $all('#tab-entries .chip').forEach(function (c) {
    c.addEventListener('click', function () { S.filterType = c.dataset.f; renderEntries(); });
  });
  $all('#tab-entries .entry-row').forEach(function (r) {
    r.addEventListener('click', function () { openEntryModal(r.dataset.id); });
  });
}

/* ---- balances ---- */
function renderBalances() {
  var list = portalEntries();
  var b = computeBalances(list);
  var oweList = [], owedList = [];
  Object.keys(b).forEach(function (k) {
    if (b[k].payable > 0) oweList.push(b[k]);
    if (b[k].receivable > 0) owedList.push(b[k]);
  });
  oweList.sort(function (a, c) { return c.payable - a.payable; });
  owedList.sort(function (a, c) { return c.receivable - a.receivable; });
  var totOwe = oweList.reduce(function (s, x) { return s + x.payable; }, 0);
  var totOwed = owedList.reduce(function (s, x) { return s + x.receivable; }, 0);

  function partyCard(p, amount, cls) {
    return '<button class="party-card" data-party="' + esc(p.party) + '">' +
      '<span class="avatar">' + esc(p.party.charAt(0).toUpperCase()) + '</span>' +
      '<span class="e-main"><span class="e-desc">' + esc(p.party) + '</span><br>' +
      '<span class="e-sub">' + p.count + ' entr' + (p.count === 1 ? 'y' : 'ies') + ' · tap to see</span></span>' +
      '<span class="bal ' + cls + '">' + fmtRs(amount) + '</span></button>';
  }

  var html = '<div class="stat-grid">' +
      '<div class="stat"><div class="k">I owe · total</div><div class="v neg">' + fmtRs(totOwe) + '</div></div>' +
      '<div class="stat"><div class="k">Owed to me · total</div><div class="v pos">' + fmtRs(totOwed) + '</div></div>' +
    '</div>' +
    '<div class="section-title">I owe (payables)</div>' +
    (oweList.length ? oweList.map(function (p) { return partyCard(p, p.payable, 'owe'); }).join('')
                   : '<div class="card empty">' + icon('check') + '<p>All clear — nobody to pay.</p></div>') +
    '<div class="section-title">Owed to me (receivables)</div>' +
    (owedList.length ? owedList.map(function (p) { return partyCard(p, p.receivable, 'owed'); }).join('')
                    : '<div class="card empty">' + icon('check') + '<p>Nobody owes you right now.</p></div>');

  $('#tab-balances').innerHTML = html;
  $all('#tab-balances .party-card').forEach(function (c) {
    c.addEventListener('click', function () {
      S.filterQ = c.dataset.party; S.filterType = 'all'; S.tab = 'entries'; renderAll();
    });
  });
}

/* ---- more tab ---- */
function renderMore() {
  var u = S.user;

  var html = '<div class="section-title">Backup — keeps your data safe</div>' +
    '<div class="card menu-card">' +
      '<button class="menu-item" id="m-export">' + icon('download') + '<span>Export backup<span class="sub">Download this account\'s records as a JSON file</span></span></button>' +
      '<button class="menu-item" id="m-import">' + icon('upload') + '<span>Import backup<span class="sub">Restore this account from a JSON backup file</span></span></button>' +
    '</div>';

  html += '<div class="section-title">Data</div><div class="card menu-card">' +
    '<button class="menu-item" id="m-sample">' + icon('book') + '<span>Load sample entries<span class="sub">Try the app with example data</span></span></button>' +
    '<button class="menu-item danger-item" id="m-clear">' + icon('trash') + '<span>Clear this portal\'s entries<span class="sub">Deletes all ' + (S.portal === 'personal' ? 'Personal' : 'Business') + ' entries of this account</span></span></button>' +
    '</div>' +

    '<div class="card"><h3>Good to know</h3>' +
    '<p class="fineprint">' + (u.kind === 'google'
      ? 'This account syncs to a private app folder in <b>your own Google Drive</b> — sign in with the same Gmail on any browser or phone and your records come with you. A copy is also kept in this browser, so you can still see your khata offline; changes sync when you are back online.'
      : 'This account\'s records live only in this device\'s browser — they are not synced anywhere, ' +
        'and nobody else on this device can see them. ' +
        'Clearing browser data erases them, so export a backup regularly (above). ' +
        'Logins on this device are family-convenience locks, not bank-grade security.') + '</p>' +
    '<p class="fineprint"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p></div>';

  $('#tab-more').innerHTML = html;

  $('#m-export').addEventListener('click', exportBackup);
  $('#m-import').addEventListener('click', function () { $('#import-file').click(); });
  $('#m-sample').addEventListener('click', loadSampleData);
  $('#m-clear').addEventListener('click', function () {
    confirmDlg('Clear entries?', 'Delete ALL ' + (S.portal === 'personal' ? 'Personal' : 'Business') +
      ' entries of this account? This cannot be undone — export a backup first.', 'Delete all', function () {
        setPortalEntries([]); renderAll(); toast('Entries cleared.');
      });
  });
}

/* ---------------- JSON backup: export / import (this account only) ---------------- */
function exportBackup() {
  var payload = {
    app: 'hisab', version: 2, exportedAt: new Date().toISOString(),
    exportedBy: S.user ? accountLabel() : 'unknown',
    entries: loadJSON(dataKey(), blankEntries())
  };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  var safe = String(accountLabel()).toLowerCase().replace(/[^a-z0-9_@.-]+/g, '_');
  a.download = 'hisab-backup-' + safe + '-' + dateKey(Date.now()) + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('Backup downloaded. Keep it somewhere safe.');
}

function importBackup(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var data;
    try { data = JSON.parse(reader.result); }
    catch (e) { toast('That file is not valid JSON.'); return; }
    if (!data || data.app !== 'hisab' || !data.entries ||
        !Array.isArray(data.entries.personal) || !Array.isArray(data.entries.business)) {
      toast('Not a Hisab backup file.'); return;
    }
    confirmDlg('Import backup?', 'Replace ALL of ' + accountLabel() + '\'s records with the backup from ' +
      (data.exportedAt ? fmtDateTime(Date.parse(data.exportedAt)) : 'unknown date') + '?', 'Import', function () {
        S.entries = { personal: data.entries.personal, business: data.entries.business };
        saveJSON(dataKey(), S.entries);
        if (S.user.kind === 'google' && typeof Drive !== 'undefined') Drive.scheduleSave(drivePayload);
        S.filterQ = ''; S.filterType = 'all';
        renderAll();
        toast('Backup imported.');
      });
  };
  reader.readAsText(file);
}

/* ---------------- sample data (for trying the app) ---------------- */
function loadSampleData() {
  confirmDlg('Load samples?', 'Add example entries to the ' +
    (S.portal === 'personal' ? 'Personal' : 'Business') + ' portal so you can explore?', 'Add samples', function () {
      var now = Date.now(), day = 864e5;
      var samples = S.portal === 'personal' ? [
        { d: 'Rice, lentils & oil', a: 2450, p: 'Bhatbhateni', t: 'cash_purchase', off: 0 },
        { d: 'Vegetables', a: 380, p: 'Kalimati vendor', t: 'due_purchase', off: 0 },
        { d: 'Gave Ramesh', a: 5000, p: 'Ramesh', t: 'money_given', off: 1 },
        { d: 'Took from Sita', a: 2000, p: 'Sita', t: 'money_taken', off: 2 },
        { d: 'Paid Kalimati vendor', a: 380, p: 'Kalimati vendor', t: 'paid_back', off: 3 },
        { d: 'Ramesh returned part', a: 1500, p: 'Ramesh', t: 'received_back', off: 4 },
        { d: 'Milk (week)', a: 840, p: 'Dairy', t: 'cash_purchase', off: 5 }
      ] : [
        { d: 'Paracetamol stock', a: 8500, p: 'Sharma Suppliers', t: 'due_purchase', off: 0 },
        { d: 'Counter sale', a: 3200, p: '', t: 'cash_purchase', off: 0 },
        { d: 'Paid Sharma Suppliers', a: 5000, p: 'Sharma Suppliers', t: 'paid_back', off: 1 },
        { d: 'Antibiotics stock', a: 12000, p: 'City Pharma', t: 'due_purchase', off: 2 },
        { d: 'Gave staff advance', a: 10000, p: 'Hari', t: 'money_given', off: 3 }
      ];
      var list = portalEntries();
      samples.forEach(function (s) {
        list.push({ id: uid(), ts: now - s.off * day, type: s.t, desc: s.d,
                    amount: s.a, party: s.p, note: 'sample' });
      });
      setPortalEntries(list);
      renderAll();
      toast('Sample entries added.');
    });
}

/* ---------------- entry modal (add / edit) ---------------- */
function openEntryModal(id) {
  S.editingId = id || null;
  var e = id ? getEntry(id) : null;
  S.entryType = e ? e.type : 'cash_purchase';
  $('#entry-modal-title').textContent = e ? 'Edit entry' : 'New entry';
  $('#entry-delete').hidden = !e;
  renderTypeGrid();
  $('#f-desc').value = e ? e.desc : '';
  $('#f-amount').value = e ? e.amount : '';
  $('#f-when').value = e ? inputValueFromTs(e.ts) : inputNow();
  $('#f-party').value = e ? e.party : '';
  $('#f-note').value = e && e.note !== 'sample' ? e.note : '';
  updatePartyLabel();
  $('#entry-modal').hidden = false;
  setTimeout(function () { $('#f-desc').focus(); }, 60);
}
/* datetime-local value from an epoch ts (Kathmandu wall clock) */
function inputValueFromTs(ts) {
  var p = tzParts(ts);
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
}
function renderTypeGrid() {
  $('#type-grid').innerHTML = TYPE_ORDER.map(function (k) {
    var t = TYPES[k];
    return '<button type="button" class="type-btn' + (S.entryType === k ? ' active' : '') + '" data-t="' + k + '">' +
      icon(t.icon) + '<span>' + esc(t.label) + '</span></button>';
  }).join('');
  $all('#type-grid .type-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      S.entryType = b.dataset.t;
      renderTypeGrid();
      updatePartyLabel();
    });
  });
}
function updatePartyLabel() {
  $('#f-party-label').textContent = TYPES[S.entryType].partyLabel;
}
function closeEntryModal() { $('#entry-modal').hidden = true; S.editingId = null; }

function handleEntrySubmit(ev) {
  ev.preventDefault();
  var desc = $('#f-desc').value.trim();
  var amount = Number($('#f-amount').value);
  if (!desc) { toast('Add a short description.'); return; }
  if (!(amount > 0)) { toast('Enter an amount greater than 0.'); return; }
  var data = {
    ts: tsFromInput($('#f-when').value),
    type: S.entryType, desc: desc, amount: amount,
    party: $('#f-party').value.trim(), note: $('#f-note').value.trim()
  };
  if (S.editingId) { updateEntry(S.editingId, data); toast('Entry updated.'); }
  else { addEntry(data); toast('Saved — ' + fmtRs(data.amount) + '.'); }
  closeEntryModal();
  renderAll();
}

/* ---------------- init & wiring ---------------- */
document.addEventListener('DOMContentLoaded', function () {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#create-form').addEventListener('submit', handleCreate);
  $('#show-create').addEventListener('click', function () {
    $('#login-error').hidden = true; showView('create');
  });
  $('#show-login').addEventListener('click', function () {
    $('#create-error').hidden = true; showView('login');
  });

  $('#portal-personal').addEventListener('click', function () { S.portal = 'personal'; renderAll(); });
  $('#portal-business').addEventListener('click', function () { S.portal = 'business'; renderAll(); });

  $all('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () { S.tab = b.dataset.tab; renderAll(); });
  });

  $('#fab').addEventListener('click', function () { openEntryModal(null); });
  $('#user-chip').addEventListener('click', openAccountMenu);
  $('#account-close').addEventListener('click', closeAccountMenu);
  $('#account-modal').addEventListener('click', function (ev) { if (ev.target === this) closeAccountMenu(); });
  $('#account-switch').addEventListener('click', function () { closeAccountMenu(); logout(); });
  $('#account-logout').addEventListener('click', function () { closeAccountMenu(); logout(); });
  var gbLogin = $('#google-btn-login');
  if (gbLogin) gbLogin.addEventListener('click', function () { googleSignInFlow(); });
  var gbCreate = $('#google-btn-create');
  if (gbCreate) gbCreate.addEventListener('click', function () { googleSignInFlow(); });
  var caBtn = $('#continue-as-btn');
  if (caBtn) caBtn.addEventListener('click', function () {
    var prof = (typeof Drive !== 'undefined') && Drive.readProfile();
    googleSignInFlow(prof && prof.email);
  });
  var rcBtn = $('#account-reconnect');
  if (rcBtn) rcBtn.addEventListener('click', function () { closeAccountMenu(); googleSignInFlow(); });

  $('#entry-form').addEventListener('submit', handleEntrySubmit);
  $('#entry-close').addEventListener('click', closeEntryModal);
  $('#entry-cancel').addEventListener('click', closeEntryModal);
  $('#entry-delete').addEventListener('click', function () {
    var e = S.editingId ? getEntry(S.editingId) : null;
    if (!e) return;
    confirmDlg('Delete entry?', '"' + e.desc + '" — ' + fmtRs(e.amount) + ' · ' + fmtDateTime(e.ts), 'Delete', function () {
      deleteEntry(e.id);
      closeEntryModal();
      renderAll();
      toast('Entry deleted.');
    });
  });
  $('#entry-modal').addEventListener('click', function (ev) { if (ev.target === this) closeEntryModal(); });

  $('#confirm-no').addEventListener('click', function () { $('#confirm-modal').hidden = true; _confirmCb = null; });
  $('#confirm-yes').addEventListener('click', function () {
    $('#confirm-modal').hidden = true;
    var cb = _confirmCb; _confirmCb = null;
    if (cb) cb();
  });

  $('#import-file').addEventListener('change', function () {
    if (this.files && this.files[0]) importBackup(this.files[0]);
    this.value = '';
  });

  boot();
});
