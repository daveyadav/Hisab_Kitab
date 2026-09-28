/* =========================================================================
 * Hisab — a calm khata (ledger) book, with analytics.
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
 * Each account can set a NICKNAME (display name). It is stored per
 * account and — for Google accounts — synced inside the Drive payload,
 * so it follows the person to every device.
 *
 * SECURITY NOTE: local logins are salted SHA-256 (WebCrypto when
 * available) and are family-convenience locks, NOT bank-grade security.
 * Google accounts rely on Google's own sign-in; the app only ever sees
 * the files it created inside the user's private Drive app folder.
 * ========================================================================= */
'use strict';

/* ---------------- constants ---------------- */
var TZ = 'Asia/Kathmandu';
/* Storage layout
 * Local accounts (per-device):
 *  hisab_accounts_v2            = { lowercasedName: {name, salt, algo, passHash, createdAt} }
 * Google accounts: no password record here — identity comes from Google;
 *  hisab_google_profile         = { email, name, picture } (for "Continue as …")
 * Per-account records (both kinds):
 *  hisab_data_v2_<key>          = { personal: [...], business: [...] }
 *  hisab_profile_v1_<key>       = { nickname, dismissedNudge }
 *    where <key> is the lowercased username, or 'g_' + lowercased Gmail.
 *    (For Google accounts these double as the offline cache of Drive.)
 * Session:
 *  hisab_session_v2             = { kind: 'local'|'google', id: <key> }
 * Device preferences:
 *  hisab_theme  = 'system' | 'light' | 'dark'
 *  hisab_period = dashboard period                                        */
var LS_ACCOUNTS = 'hisab_accounts_v2';
var LS_SESSION  = 'hisab_session_v2';
var LS_THEME    = 'hisab_theme';
var LS_PERIOD   = 'hisab_period';
function accountStoreKey() {
  if (S.user.kind === 'google') return 'g_' + S.user.id;
  return S.user.id;
}
function lsDataKey(name) { return 'hisab_data_v2_' + String(name || '').trim().toLowerCase(); }
function profileKeyFor(storeKey) { return 'hisab_profile_v1_' + storeKey; }

/* Entry types. `flow` drives totals and balances:
 *  - cash: money left my hand right now (purchase paid in cash)
 *  - payable+: I now owe more (bought on due / took money)
 *  - payable-: I paid some of what I owed
 *  - receivable+: someone now owes me (I gave/lent money)
 *  - receivable-: someone paid me back
 * `color` is a fixed categorical slot (CSS --t1…--t6), so a type keeps
 * its colour everywhere: list icons, filters, charts.                     */
var TYPES = {
  cash_purchase:  { label: 'Cash purchase',  short: 'Cash',      partyLabel: 'Shop / vendor (optional)', flow: 'cash',        icon: 'cart',    color: 't1' },
  due_purchase:   { label: 'Bought on due',  short: 'On due',    partyLabel: 'Shop / vendor',            flow: 'payable+',    icon: 'receipt', color: 't2' },
  money_given:    { label: 'Gave money',     short: 'Gave',      partyLabel: 'Person',                   flow: 'receivable+', icon: 'up',      color: 't3' },
  money_taken:    { label: 'Took money',     short: 'Took',      partyLabel: 'Person',                   flow: 'payable+',    icon: 'down',    color: 't4' },
  paid_back:      { label: 'I paid back',    short: 'Paid back', partyLabel: 'Person / vendor',          flow: 'payable-',    icon: 'check',   color: 't5' },
  received_back:  { label: 'Got money back', short: 'Got back',  partyLabel: 'Person',                   flow: 'receivable-', icon: 'inbox',   color: 't6' }
};
var TYPE_ORDER = ['cash_purchase', 'due_purchase', 'money_given', 'money_taken', 'paid_back', 'received_back'];

/* Analytics buckets:
 *  spent = things bought (cash + on due)
 *  out   = cash that left my hand (cash purchase, gave money, paid back)
 *  in    = cash that came to me (took money, got money back)            */
var IS_SPENT = { cash_purchase: 1, due_purchase: 1 };
var IS_OUT   = { cash_purchase: 1, money_given: 1, paid_back: 1 };
var IS_IN    = { money_taken: 1, received_back: 1 };

/* ---------------- tiny DOM helpers ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function $all(s, r) {
  var root = r || document;
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.prototype.slice.call(root.querySelectorAll(s) || []);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function uid() {
  return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
var RAF = (typeof requestAnimationFrame === 'function')
  ? function (f) { return requestAnimationFrame(f); }
  : function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
function reduceMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}

/* ---------------- inline SVG icons ---------------- */
var ICONS = {
  home:    '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  chart:   '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
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
  user:    '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
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
  book:    '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>',
  chev:    '<path d="M9 6l6 6-6 6"/>',
  sun:     '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:    '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  wallet:  '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="16.5" cy="13.5" r="1.3"/>',
  arrowOut:'<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
  arrowIn: '<path d="M17 7L7 17"/><path d="M16 17H7V8"/>',
  pulse:   '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  hash:    '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>'
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
function loadStr(key, fallback) {
  try { var v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function saveStr(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }

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
var _dtfDateShort = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
var _dtfTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
var _dtfParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
var _dtfWd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
var _dtfMon = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' });
var _dtfMonYear = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var DAY = 864e5;

function tzParts(ts) {
  var o = {};
  _dtfParts.formatToParts(ts).forEach(function (p) { o[p.type] = p.value; });
  if (o.hour === '24') o.hour = '00';
  return o; // {year, month, day, hour, minute}
}
function dateKey(ts) { var p = tzParts(ts); return p.year + '-' + p.month + '-' + p.day; }
function monthKey(ts) { var p = tzParts(ts); return p.year + '-' + p.month; }
function fmtDate(ts) { return _dtfDate.format(ts); }          // "Sun, 28 Sept 2026"
function fmtTime(ts) { return _dtfTime.format(ts); }          // "3:50 PM"
function fmtDateTime(ts) { return fmtDate(ts) + ' · ' + fmtTime(ts); }
function todayKey() { return dateKey(Date.now()); }
function thisMonthKey() { return monthKey(Date.now()); }
function weekdayIdx(ts) { return WEEKDAYS.indexOf(_dtfWd.format(ts)); }

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
function dayStart(key) { return tsFromInput(key + 'T00:00'); }
function shiftMonth(key, n) {
  var y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + ('0' + (m + 1)).slice(-2);
}
function monthLabel(key) { return _dtfMon.format(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 15)); }
function monthLong(key) { return _dtfMonYear.format(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 15)); }

/* Nepal uses lakh/crore grouping: 1,25,000 — en-IN matches. */
function fmtRs(n) {
  var v = Math.round(Number(n) || 0);
  return (v < 0 ? '−' : '') + 'Rs ' + Math.abs(v).toLocaleString('en-IN');
}
function fmtNum(n) { return Math.round(Number(n) || 0).toLocaleString('en-IN'); }
/* Compact, lakh-aware: 950 · 12.5K · 3.2L · 1.1Cr */
function fmtCompact(n) {
  var v = Math.abs(Number(n) || 0), s;
  if (v < 1000) s = String(Math.round(v));
  else if (v < 1e5) s = trim1(v / 1e3) + 'K';
  else if (v < 1e7) s = trim1(v / 1e5) + 'L';
  else s = trim1(v / 1e7) + 'Cr';
  return (n < 0 ? '−' : '') + s;
}
function trim1(x) { return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString(); }
function niceCeil(v) {
  if (!(v > 0)) return 0;
  var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), f = v / e;
  var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10], nf = 10;
  for (var i = 0; i < steps.length; i++) if (f <= steps[i] + 1e-9) { nf = steps[i]; break; }
  return nf * e;
}
function hueOf(str) {
  var h = 0, s = String(str || '');
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
function initials(name) {
  var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}
function avatarHTML(name, picture, cls) {
  if (picture) return '<span class="avatar ' + (cls || '') + '"><img src="' + esc(picture) + '" alt="" referrerpolicy="no-referrer"></span>';
  return '<span class="avatar ' + (cls || '') + '" style="--h:' + hueOf(name) + '">' + esc(initials(name)) + '</span>';
}

/* ---------------- app state ---------------- */
var S = {
  user: null,            // { kind:'local'|'google', id, displayName, picture }
  profile: { nickname: '', dismissedNudge: false },
  portal: 'personal',    // 'personal' | 'business'
  tab: 'dashboard',
  period: '30d',         // dashboard period
  entries: { personal: [], business: [] },
  filterQ: '',
  filterType: 'all',
  editingId: null,       // entry id being edited (null = new)
  entryType: 'cash_purchase'
};

function dataKey() { return 'hisab_data_v2_' + accountStoreKey(); }
function profileKey() { return profileKeyFor(accountStoreKey()); }
/* The name Hisab uses for the person: their nickname if set, otherwise
 * their Google name / local username. */
function displayName() {
  if (!S.user) return '';
  var n = S.profile && S.profile.nickname;
  return n ? n : S.user.displayName;
}
/* Human label for the signed-in account: Gmail for Google, username for local. */
function accountLabel() {
  if (!S.user) return 'unknown';
  return S.user.kind === 'google' ? S.user.id : S.user.displayName;
}
function blankEntries() { return { personal: [], business: [] }; }
function portalEntries() { return S.entries[S.portal] || []; }
function portalName() { return S.portal === 'personal' ? 'Personal' : 'Business'; }
function setPortalEntries(list) {
  S.entries[S.portal] = list;
  saveJSON(dataKey(), S.entries);
  queueDriveSave();
}
/* Google accounts: queue an upload to Drive (debounced, 2s). */
function queueDriveSave() {
  if (S.user && S.user.kind === 'google' && typeof Drive !== 'undefined') {
    Drive.scheduleSave(drivePayload);
  }
}
/* Snapshot uploaded to Drive on every mutation (last write wins). */
function drivePayload() {
  return {
    app: 'hisab', version: 4, updatedAt: Date.now(),
    profile: { nickname: (S.profile && S.profile.nickname) || '' },
    entries: S.entries
  };
}
function validEntriesShape(e) {
  return !!(e && Array.isArray(e.personal) && Array.isArray(e.business));
}
function cleanNickname(v) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 30); }
function loadProfileFor(storeKey) {
  var p = loadJSON(profileKeyFor(storeKey), null) || {};
  return { nickname: cleanNickname(p.nickname), dismissedNudge: !!p.dismissedNudge };
}
function saveProfile() {
  saveJSON(profileKey(), S.profile);
  queueDriveSave();
}
function setNickname(v) {
  S.profile.nickname = cleanNickname(v);
  saveProfile();
}

/* ---------------- theme ---------------- */
function getTheme() {
  var t = loadStr(LS_THEME, 'system');
  return (t === 'light' || t === 'dark') ? t : 'system';
}
function applyTheme(t) {
  var root = (typeof document !== 'undefined') && document.documentElement;
  if (!root || typeof root.setAttribute !== 'function') return;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
}
function setTheme(t) { saveStr(LS_THEME, t); applyTheme(t); }

/* ---------------- toast + confirm + modals ---------------- */
var _toastTimer = null, _toastHide = null;
function toast(msg) {
  var t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(_toastTimer); clearTimeout(_toastHide);
  void t.offsetWidth;
  if (t.classList) t.classList.add('show');
  _toastTimer = setTimeout(function () {
    if (t.classList) t.classList.remove('show');
    _toastHide = setTimeout(function () { t.hidden = true; }, 320);
  }, 2600);
}
function openModal(sel) {
  var m = $(sel);
  if (!m) return;
  clearTimeout(m._closeT);
  m.hidden = false;
  void m.offsetWidth;
  RAF(function () { if (m.classList) m.classList.add('open'); });
}
function closeModal(sel) {
  var m = $(sel);
  if (!m) return;
  if (m.classList) m.classList.remove('open');
  clearTimeout(m._closeT);
  m._closeT = setTimeout(function () { m.hidden = true; }, reduceMotion() ? 0 : 300);
}
var _confirmCb = null;
function confirmDlg(title, text, yesLabel, cb) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yesLabel || 'Confirm';
  _confirmCb = cb;
  openModal('#confirm-modal');
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
  try { window.scrollTo(0, 0); } catch (e) {}
}

function localUserFrom(account) {
  return { kind: 'local', id: account.name.toLowerCase(), displayName: account.name, picture: '' };
}

function boot() {
  applyTheme(getTheme());
  var p = loadStr(LS_PERIOD, '30d');
  if (PERIODS[p]) S.period = p;

  // static icons
  $('#fab').innerHTML = icon('plus');
  $('#entry-close').innerHTML = icon('x');
  $('#account-close').innerHTML = icon('x');
  $('#report-close').innerHTML = icon('x');
  var navIcons = { dashboard: 'chart', entries: 'list', balances: 'swap', more: 'dots' };
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
  if (account) { loginAs(localUserFrom(account), true); return; }

  if (sess && sess.kind === 'google' && typeof Drive !== 'undefined') {
    /* Last time was a Google account: restore the session straight from the
     * local cache — no Google popup, and no token request without a real
     * user gesture. Cached records open immediately; one tap on
     * "Tap to reconnect" refreshes the Google token and resumes Drive sync. */
    var prof = Drive.readProfile();
    if (prof && prof.email) {
      restoreGoogleSession(prof);
      return;
    }
  }
  showView('login');
}

/* Restore a Google session from the local cache, then quietly refresh the
 * Drive token in the background (Google's script loads async, so wait for
 * it briefly). The "Tap to reconnect" pill only appears if Google genuinely
 * needs a manual tap; when everything works the user never sees it. */
function restoreGoogleSession(prof) {
  loginAs({ kind: 'google', id: String(prof.email).toLowerCase(),
            displayName: prof.name || prof.email, picture: prof.picture || '' }, true);
  var tries = 0;
  var timer = setInterval(function () {
    if (Drive.gisLoaded() || ++tries > 20) {
      clearInterval(timer);
      if (Drive.gisLoaded()) {
        Drive.silentReconnect().then(function (ok) { if (!ok) Drive.noteReauth(); });
      }
      /* If Google's script never arrived (offline), stay quiet: the queued
       * Drive upload retries automatically when connectivity returns. */
    }
  }, 500);
}

function loginAs(user, quiet) {
  S.user = user;
  S.portal = 'personal';
  S.tab = 'dashboard';
  S.filterQ = ''; S.filterType = 'all'; S.editingId = null;
  S.entries = loadJSON(dataKey(), blankEntries());
  if (!Array.isArray(S.entries.personal)) S.entries.personal = [];
  if (!Array.isArray(S.entries.business)) S.entries.business = [];
  S.profile = loadProfileFor(accountStoreKey());
  saveJSON(LS_SESSION, { kind: user.kind, id: user.id });
  hideContinueAs();
  showView('main');
  renderAll(true);
  updateSyncPill(typeof Drive !== 'undefined' ? Drive.getStatus() : 'disabled');
  if (!quiet) toast('Namaste, ' + displayName());
}

function logout() {
  if (S.user && S.user.kind === 'google' && typeof Drive !== 'undefined') Drive.signOut();
  try { localStorage.removeItem(LS_SESSION); } catch (e) {}
  S.user = null;
  S.profile = { nickname: '', dismissedNudge: false };
  clearPrintedReport();
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
  var nickEl = $('#create-nickname');
  var nick = cleanNickname(nickEl ? nickEl.value : '');
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
    if (nick) saveJSON(profileKeyFor(key), { nickname: nick, dismissedNudge: false });
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

/* ---- profile / account sheet ---- */
function openAccountMenu(focusNickname) {
  if (!S.user) return;
  $('#account-name').textContent = displayName();
  var av = $('#account-avatar');
  av.style && av.style.setProperty && av.style.setProperty('--h', hueOf(displayName()));
  if (S.user.picture) av.innerHTML = '<img src="' + esc(S.user.picture) + '" alt="" referrerpolicy="no-referrer">';
  else av.textContent = initials(displayName());
  $('#account-sub').textContent = S.user.kind === 'google'
    ? S.user.id + ' · synced via Google Drive'
    : '@' + S.user.displayName + ' · device-only account';
  $('#account-nickname').value = S.profile.nickname || '';
  $('#account-nickname').placeholder = 'e.g. ' + (S.user.kind === 'google' ? String(S.user.displayName).split(' ')[0] : 'Kaji Dai');
  $('#nickname-hint').textContent = S.user.kind === 'google'
    ? 'Shown in greetings and the top bar. Syncs to your other devices with your khata.'
    : 'Shown in greetings and the top bar. Leave empty to use “' + S.user.displayName + '”.';
  var rc = $('#account-reconnect');
  if (rc) rc.hidden = !(S.user.kind === 'google' && typeof Drive !== 'undefined' && Drive.getStatus() === 'reauth');
  openModal('#account-modal');
  if (focusNickname) setTimeout(function () { var i = $('#account-nickname'); if (i && i.focus) i.focus(); }, 260);
}
function closeAccountMenu() { closeModal('#account-modal'); }
function handleNicknameSave(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  var v = cleanNickname($('#account-nickname').value);
  var changed = v !== (S.profile.nickname || '');
  setNickname(v);
  closeAccountMenu();
  renderAll(false);
  if (changed) toast(v ? 'Nice to meet you, ' + v + '!' : 'Nickname cleared.');
}

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

/* One-tap "Continue as <nickname or name>" shown when the last session was Google. */
function showContinueAs(prof) {
  var wrap = $('#continue-as-wrap'), btn = $('#continue-as-btn');
  if (!wrap || !btn) return;
  var nick = loadProfileFor('g_' + String(prof.email).toLowerCase()).nickname;
  btn.innerHTML =
    (prof.picture ? '<img class="g-avatar" src="' + esc(prof.picture) + '" alt="" referrerpolicy="no-referrer">' : avatarHTML(nick || prof.name || prof.email, '', 'sm')) +
    '<span class="g-text"><span class="g-title">Continue as ' + esc(nick || prof.name || prof.email) + '</span>' +
    '<span class="g-sub">' + esc(prof.email) + '</span></span>';
  wrap.hidden = false;
}
function hideContinueAs() {
  var wrap = $('#continue-as-wrap');
  if (wrap) wrap.hidden = true;
}

/* Turn a Google sign-in failure into a plain-language message. */
function googleErrorText(err) {
  var code = err && err.message ? String(err.message) : '';
  if (code === 'access_denied' || code === 'token-denied')
    return 'Google refused access. The app is probably still in Testing mode — it must be Published (In production) so any Gmail can sign in.';
  if (code === 'popup_closed_by_user')
    return 'The Google window closed before sign-in finished. Please tap "Sign in with Google" and try again.';
  if (code === 'immediate_failed' || code === 'google-unavailable')
    return 'Could not reach Google. Check your internet connection and try again.';
  if (code === 'userinfo-failed' || code === 'no-email')
    return 'Google responded but your profile could not be read. Please try again.';
  return 'Google sign-in didn\'t complete' + (code ? ' (' + code + ')' : '') +
    '. You can use a device-only account instead.';
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
      /* Synced nickname wins over the local cache when Drive has one. */
      if (remote && remote.profile && typeof remote.profile.nickname === 'string') {
        var local = loadProfileFor(accountStoreKey());
        local.nickname = cleanNickname(remote.profile.nickname);
        saveJSON(profileKey(), local);
      }
      Drive.writeProfile(profile);
      loginAs(user, true);
      Drive.markInSync();
      updateSyncPill(Drive.getStatus());
      toast(remote ? 'Namaste, ' + displayName() + ' — synced from your Drive.' : 'Signed in with Google — fresh khata ready.');
    });
  }).catch(function (err) {
    toast(googleErrorText(err));
  }).then(function () {
    setGoogleBusy(false);
    renderGoogleButtons();
  });
}

/* Sync-status pill in the top bar (Google accounts only).
 * Writes to the DOM only when something actually changed: re-setting the
 * class replays CSS animations and resizing the pill shoves the sticky
 * header around, which reads as the page "shaking". */
var _pillKey = null;
function updateSyncPill(s) {
  var pill = $('#sync-pill');
  if (!pill) return;
  if (!S.user || S.user.kind !== 'google' || s === 'disabled') {
    if (_pillKey === 'hidden') return;
    _pillKey = 'hidden';
    pill.hidden = true; pill.onclick = null; return;
  }
  var key = s + '|' + S.user.id;
  if (key === _pillKey) return;
  _pillKey = key;
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
  Object.keys(b).forEach(function (k) {
    if (b[k].payable > 0) owe += b[k].payable;
    if (b[k].receivable > 0) owed += b[k].receivable;
  });
  return { owe: owe, owed: owed };
}

/* =========================================================================
 * Analytics
 * ========================================================================= */
var PERIODS = {
  '7d':    { label: '7D',    long: 'Last 7 days',    prevLabel: 'prev. 7 days' },
  '30d':   { label: '30D',   long: 'Last 30 days',   prevLabel: 'prev. 30 days' },
  'month': { label: 'Month', long: 'This month',     prevLabel: 'same days last month' },
  '12m':   { label: '12M',   long: 'Last 12 months', prevLabel: 'prev. 12 months' },
  'all':   { label: 'All',   long: 'All time',       prevLabel: '' }
};
var WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var PERIOD_ORDER = ['7d', '30d', 'month', '12m', 'all'];

/* Build the period window + its buckets (Kathmandu calendar). */
function periodWindow(p, list) {
  var today = todayKey(), t0 = dayStart(today), w = { buckets: [], unit: 'day' };
  function dailyBuckets(start, n, weekdayLabels) {
    for (var i = 0; i < n; i++) {
      var ts = start + i * DAY + DAY / 2, k = dateKey(ts), parts = tzParts(ts);
      w.buckets.push({
        key: k,
        label: weekdayLabels ? _dtfWd.format(ts) : String(+parts.day),
        long: fmtDate(ts), in: 0, out: 0, spent: 0
      });
    }
  }
  function monthlyBuckets(firstKey, n) {
    for (var i = 0; i < n; i++) {
      var k = shiftMonth(firstKey, i);
      w.buckets.push({ key: k, label: monthLabel(k), long: monthLong(k), in: 0, out: 0, spent: 0 });
    }
  }
  if (p === '7d' || p === '30d') {
    var n = p === '7d' ? 7 : 30;
    w.start = t0 - (n - 1) * DAY; w.end = t0 + DAY;
    w.prevStart = w.start - n * DAY; w.prevEnd = w.start;
    w.days = n;
    dailyBuckets(w.start, n, p === '7d');
  } else if (p === 'month') {
    var mk = thisMonthKey(), first = dayStart(mk + '-01');
    var days = Math.round((t0 - first) / DAY) + 1;
    w.start = first; w.end = t0 + DAY; w.days = days;
    var pm = dayStart(shiftMonth(mk, -1) + '-01');
    w.prevStart = pm; w.prevEnd = Math.min(pm + days * DAY, first);
    dailyBuckets(first, days, false);
  } else {
    var cur = thisMonthKey(), firstKey, count;
    if (p === '12m') { firstKey = shiftMonth(cur, -11); count = 12; }
    else {
      var min = null;
      list.forEach(function (e) { if (min === null || e.ts < min) min = e.ts; });
      firstKey = min === null ? shiftMonth(cur, -5) : monthKey(min);
      count = monthsBetween(firstKey, cur) + 1;
      if (count < 6) { firstKey = shiftMonth(cur, -5); count = 6; }
    }
    w.unit = 'month';
    w.start = dayStart(firstKey + '-01'); w.end = t0 + DAY;
    w.days = Math.max(1, Math.round((w.end - w.start) / DAY));
    if (p === '12m') { w.prevStart = dayStart(shiftMonth(firstKey, -12) + '-01'); w.prevEnd = w.start; }
    monthlyBuckets(firstKey, count);
  }
  return w;
}
function monthsBetween(a, b) {
  return (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
}

function blankStats() {
  var byType = {};
  TYPE_ORDER.forEach(function (k) { byType[k] = 0; });
  return { spent: 0, out: 0, in: 0, count: 0, volume: 0, byType: byType, byParty: {}, wd: [0, 0, 0, 0, 0, 0, 0], byDay: {}, biggest: null };
}
function addToStats(st, e) {
  st.count++; st.volume += e.amount;
  if (st.byType[e.type] != null) st.byType[e.type] += e.amount;
  if (IS_SPENT[e.type]) {
    st.spent += e.amount;
    var wi = weekdayIdx(e.ts); if (wi >= 0) st.wd[wi] += e.amount;
    var dk = dateKey(e.ts); st.byDay[dk] = (st.byDay[dk] || 0) + e.amount;
  }
  if (IS_OUT[e.type]) st.out += e.amount;
  if (IS_IN[e.type]) st.in += e.amount;
  if (e.party) {
    var p = st.byParty[e.party] || (st.byParty[e.party] = { party: e.party, volume: 0, count: 0 });
    p.volume += e.amount; p.count++;
  }
  if (!st.biggest || e.amount > st.biggest.amount) st.biggest = e;
}

function analyze(list, p) {
  var w = periodWindow(p, list);
  var idx = {};
  w.buckets.forEach(function (b, i) { idx[b.key] = i; });
  var cur = blankStats(), prev = w.prevStart != null ? blankStats() : null;
  list.forEach(function (e) {
    if (e.ts >= w.start && e.ts < w.end) {
      addToStats(cur, e);
      var k = w.unit === 'day' ? dateKey(e.ts) : monthKey(e.ts);
      var b = w.buckets[idx[k]];
      if (b) {
        if (IS_IN[e.type]) b.in += e.amount;
        if (IS_OUT[e.type]) b.out += e.amount;
        if (IS_SPENT[e.type]) b.spent += e.amount;
      }
    } else if (prev && e.ts >= w.prevStart && e.ts < w.prevEnd) {
      addToStats(prev, e);
    }
  });
  return { w: w, cur: cur, prev: prev };
}

/* Delta chip: `goodWhenUp` true/false, or null for neutral. */
function deltaChip(cur, prev, goodWhenUp, onDark) {
  if (prev == null) return '';
  var cls, txt, ico = '';
  if (prev === 0 && cur === 0) { cls = 'flat'; txt = 'no change'; }
  else if (prev === 0) { cls = goodWhenUp === null ? 'flat' : (goodWhenUp ? 'good' : 'bad'); txt = 'new'; ico = icon('up'); }
  else {
    var pct = Math.round((cur - prev) / prev * 100);
    if (pct === 0) { cls = 'flat'; txt = '0%'; }
    else {
      var up = pct > 0;
      cls = goodWhenUp === null ? 'flat' : ((up === goodWhenUp) ? 'good' : 'bad');
      txt = Math.abs(pct) + '%'; ico = icon(up ? 'up' : 'down');
    }
  }
  return '<span class="delta ' + (onDark ? '' : cls) + '">' + ico + esc(txt) + '</span>';
}

/* ---------------- tiny chart builders ---------------- */
var CHARTS = {};   // chart id -> data used by tooltips

/* Hero sparkline (white on the gradient card). */
function sparkline(values) {
  var n = values.length, max = 0;
  values.forEach(function (v) { if (v > max) max = v; });
  if (n < 2) return '';
  var pts = values.map(function (v, i) {
    var x = (i / (n - 1)) * 100, y = max ? 36 - (v / max) * 32 : 36;
    return [x, y];
  });
  /* Smooth Catmull-Rom → cubic Bézier, clamped to the chart box. */
  var d = 'M' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
  for (var i = 0; i < n - 1; i++) {
    var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = Math.min(38, Math.max(2, p1[1] + (p2[1] - p0[1]) / 6));
    var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = Math.min(38, Math.max(2, p2[1] - (p3[1] - p1[1]) / 6));
    d += ' C' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) + ' ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
  }
  var area = d + ' L100 40 L0 40 Z';
  return '<svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" class="wipe">' +
    '<defs><linearGradient id="spk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + area + '" fill="url(#spk)"/>' +
    '<path d="' + d + '" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
    '</svg>';
}

/* Cash-flow columns: money IN grows up, money OUT grows down, one scale. */
function flowChart(id, buckets) {
  var maxIn = 0, maxOut = 0;
  buckets.forEach(function (b) { if (b.in > maxIn) maxIn = b.in; if (b.out > maxOut) maxOut = b.out; });
  if (!maxIn && !maxOut) return emptyMini('No money moved in this period.');
  var top = niceCeil(maxIn), bot = niceCeil(maxOut), total = top + bot;
  var base = top / total * 100; // baseline % from top
  var n = buckets.length, every = Math.ceil(n / 7);
  CHARTS[id] = { kind: 'flow', buckets: buckets };
  var html = '<div class="chart-wrap" id="' + id + '"><div class="cols" role="img" aria-label="Money in and out per ' + (n > 12 ? 'day' : 'period') + '">';
  if (top) html += '<span class="grid" style="top:0"></span><span class="ylab" style="top:0">+' + fmtCompact(top) + '</span>';
  html += '<span class="grid base" style="top:' + base + '%"></span><span class="ylab" style="top:' + base + '%">0</span>';
  if (bot) html += '<span class="grid" style="top:100%"></span><span class="ylab" style="top:100%">−' + fmtCompact(bot) + '</span>';
  buckets.forEach(function (b, i) {
    html += '<div class="slot" data-i="' + i + '" style="--i:' + i + '">';
    if (b.in) html += '<span class="bar up" style="bottom:' + (100 - base) + '%;height:max(3px,' + (b.in / total * 100) + '%)"><i style="--c:var(--s-in)"></i></span>';
    if (b.out) html += '<span class="bar down" style="top:' + base + '%;height:max(3px,' + (b.out / total * 100) + '%)"><i style="--c:var(--s-out)"></i></span>';
    html += '</div>';
  });
  html += '</div><div class="xlabs">' + buckets.map(function (b, i) {
    var last = i === n - 1;
    var show = last || (i % every === 0 && (n - 1 - i) >= Math.ceil(every * 0.7));
    return '<span>' + (show ? esc(b.label) : '') + '</span>';
  }).join('') + '</div><div class="tip"></div></div>';
  return html;
}

/* Spending by weekday — one series, the busiest day emphasised. */
function weekdayChart(id, wd) {
  var max = 0, maxI = -1;
  wd.forEach(function (v, i) { if (v > max) { max = v; maxI = i; } });
  if (!max) return emptyMini('No purchases in this period.');
  var top = niceCeil(max);
  CHARTS[id] = { kind: 'wd', values: wd };
  var html = '<div class="chart-wrap" id="' + id + '"><div class="cols short" role="img" aria-label="Spending by weekday">' +
    '<span class="grid" style="top:0"></span><span class="ylab" style="top:0">' + fmtCompact(top) + '</span>' +
    '<span class="grid base" style="top:100%"></span><span class="ylab" style="top:100%">0</span>';
  wd.forEach(function (v, i) {
    var h = v / top * 100;
    html += '<div class="slot" data-i="' + i + '" style="--i:' + i + '">' +
      (v ? '<span class="bar up' + (i === maxI ? '' : ' dim') + '" style="bottom:0;height:max(3px,' + h + '%)"><i style="--c:var(--accent)"></i></span>' : '') +
      (i === maxI ? '<span class="bar-cap" style="bottom:calc(' + h + '% + 4px)">' + fmtCompact(v) + '</span>' : '') +
      '</div>';
  });
  html += '</div><div class="xlabs">' + WEEKDAYS.map(function (d) { return '<span>' + d.charAt(0) + d.charAt(1) + '</span>'; }).join('') + '</div><div class="tip"></div></div>';
  return html;
}

/* Activity by entry type — donut + legend (legend carries values, so
 * colour is never the only channel). */
function donutChart(id, byType) {
  var total = 0;
  TYPE_ORDER.forEach(function (k) { total += byType[k]; });
  if (!total) return emptyMini('No entries in this period.');
  var R = 60, C = 2 * Math.PI * R, off = 0, gap = 2;
  var segs = '', legend = '';
  var nonZero = TYPE_ORDER.filter(function (k) { return byType[k] > 0; });
  TYPE_ORDER.forEach(function (k, i) {
    var v = byType[k];
    if (!v) return;
    var len = v / total * C;
    var dash = nonZero.length > 1 ? Math.max(len - gap, 0.5) : len;
    segs += '<circle class="seg" data-k="' + k + '" cx="80" cy="80" r="' + R + '" stroke="var(--' + TYPES[k].color + ')" ' +
      'stroke-dasharray="' + dash.toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" style="animation-delay:' + (i * 90) + 'ms"/>';
    off += len;
  });
  TYPE_ORDER.forEach(function (k) {
    var v = byType[k];
    if (!v) return;
    legend += '<button type="button" data-k="' + k + '"><i style="background:var(--' + TYPES[k].color + ')"></i><span>' + esc(TYPES[k].label) +
      '</span><span class="a">' + fmtRs(v) + '</span><span class="p">' + Math.round(v / total * 100) + '%</span></button>';
  });
  CHARTS[id] = { kind: 'donut', total: total, byType: byType };
  return '<div class="donut-wrap" id="' + id + '"><div class="donut"><svg viewBox="0 0 160 160" role="img" aria-label="Activity by entry type">' +
    '<circle cx="80" cy="80" r="' + R + '" fill="none" stroke="var(--surface-3)" stroke-width="18"/>' + segs + '</svg>' +
    '<div class="mid"><b data-mid-v>' + fmtCompact(total) + '</b><span data-mid-k>Total moved</span></div></div>' +
    '<div class="dlist">' + legend + '</div></div>';
}

function emptyMini(msg) {
  return '<div class="empty" style="padding:26px 10px"><div class="em-ico">' + icon('chart') + '</div><p>' + esc(msg) + '</p></div>';
}

/* Tooltips for column charts (hover on desktop, tap on phones). */
function bindColumnChart(id) {
  var wrap = $('#' + id);
  if (!wrap || !wrap.addEventListener || !CHARTS[id]) return;
  var tip = $('.tip', wrap), data = CHARTS[id], current = -1;
  function show(slot) {
    var i = +slot.getAttribute('data-i');
    if (i === current) return;
    current = i;
    $all('.slot.hot', wrap).forEach(function (s) { s.classList.remove('hot'); });
    slot.classList.add('hot');
    var html;
    if (data.kind === 'flow') {
      var b = data.buckets[i], net = b.in - b.out;
      html = '<b>' + esc(b.long) + '</b>' +
        '<div class="r"><span><i style="background:var(--s-in)"></i>Money in</span><span>' + fmtRs(b.in) + '</span></div>' +
        '<div class="r"><span><i style="background:var(--s-out)"></i>Money out</span><span>' + fmtRs(b.out) + '</span></div>' +
        '<div class="r" style="margin-top:3px;opacity:.8"><span>Net</span><span>' + (net > 0 ? '+' : '') + fmtRs(net) + '</span></div>';
    } else {
      html = '<b>' + WEEKDAYS_LONG[i] + 's</b><div class="r"><span>Spent</span><span>' + fmtRs(data.values[i]) + '</span></div>';
    }
    tip.innerHTML = html;
    var wr = wrap.getBoundingClientRect(), sr = slot.getBoundingClientRect();
    var x = sr.left - wr.left + sr.width / 2;
    var half = (tip.offsetWidth || 150) / 2;
    x = Math.max(half, Math.min(wr.width - half, x));
    tip.style.left = x + 'px';
    tip.style.top = (sr.top - wr.top + 8) + 'px';
    tip.classList.add('show');
  }
  function hide() {
    current = -1;
    tip.classList.remove('show');
    $all('.slot.hot', wrap).forEach(function (s) { s.classList.remove('hot'); });
  }
  wrap.addEventListener('pointermove', function (ev) {
    var s = ev.target && ev.target.closest ? ev.target.closest('.slot') : null;
    if (s) show(s);
  });
  wrap.addEventListener('click', function (ev) {
    var s = ev.target && ev.target.closest ? ev.target.closest('.slot') : null;
    if (s) show(s); else hide();
  });
  wrap.addEventListener('pointerleave', hide);
}
function bindDonut(id) {
  var wrap = $('#' + id);
  if (!wrap || !wrap.addEventListener || !CHARTS[id]) return;
  var data = CHARTS[id], donut = $('.donut', wrap);
  var mv = $('[data-mid-v]', wrap), mk = $('[data-mid-k]', wrap);
  function hot(k) {
    donut.classList.toggle('has-hot', !!k);
    $all('.seg, .dlist button', wrap).forEach(function (el) { el.classList.toggle('hot', el.getAttribute('data-k') === k); });
    if (k) { mv.textContent = fmtCompact(data.byType[k]); mk.textContent = TYPES[k].short; }
    else { mv.textContent = fmtCompact(data.total); mk.textContent = 'Total moved'; }
  }
  $all('[data-k]', wrap).forEach(function (el) {
    el.addEventListener('pointerenter', function () { hot(el.getAttribute('data-k')); });
    el.addEventListener('pointerleave', function () { hot(null); });
    el.addEventListener('click', function () {
      var k = el.getAttribute('data-k');
      S.filterType = k; S.filterQ = ''; S.tab = 'entries'; renderAll(true);
    });
  });
}

/* Numbers count up from 0 on first paint. */
function countUp(root) {
  var els = $all('[data-count]', root);
  if (!els.length) return;
  var reduce = reduceMotion();
  els.forEach(function (el) {
    var target = Number(el.getAttribute('data-count')) || 0;
    var fmt = el.getAttribute('data-fmt') === 'n' ? fmtNum : el.getAttribute('data-fmt') === 'signed'
      ? function (v) { return (v > 0 ? '+' : '') + fmtRs(v); } : fmtRs;
    if (reduce || !target) { el.textContent = fmt(target); return; }
    var t0 = null, dur = 900;
    function step(now) {
      if (t0 === null) t0 = now;
      var k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(target * e);
      if (k < 1) RAF(step);
    }
    el.textContent = fmt(0);
    RAF(step);
  });
}

/* Stagger children in (used on navigation). */
function staggerIn(el) {
  if (!el || !el.classList || !el.children) return;
  el.classList.remove('anim');
  var kids = el.children;
  for (var i = 0; i < kids.length; i++) kids[i].style.setProperty('--i', Math.min(i, 10));
  void el.offsetWidth;
  el.classList.add('anim');
}
/* Sliding thumb for a .segmented control. */
function syncSegmented(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  var btns = $all('button', root), thumb = $('.thumb', root), idx = 0;
  if (!thumb || !btns.length) return;
  btns.forEach(function (b, i) { if (b.classList.contains('active')) idx = i; });
  thumb.style.width = 'calc((100% - 8px) / ' + btns.length + ')';
  thumb.style.transform = 'translateX(' + (idx * 100) + '%)';
}
function segmentedHTML(id, options, active, cls) {
  return '<div class="segmented ' + (cls || '') + '" id="' + id + '"><span class="thumb" aria-hidden="true"></span>' +
    options.map(function (o) {
      return '<button type="button" data-v="' + esc(o.v) + '" class="' + (o.v === active ? 'active' : '') + '">' + (o.icon ? icon(o.icon) : '') + esc(o.label) + '</button>';
    }).join('') + '</div>';
}

/* =========================================================================
 * Rendering
 * ========================================================================= */
function renderAll(animate) {
  if (!S.user) return;
  renderHeader();
  $all('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === S.tab); });
  ['dashboard', 'entries', 'balances', 'more'].forEach(function (t) { $('#tab-' + t).hidden = (t !== S.tab); });
  if (S.tab === 'dashboard') renderDashboard();
  else if (S.tab === 'entries') renderEntries();
  else if (S.tab === 'balances') renderBalances();
  else renderMore();
  var fab = $('#fab');
  if (fab) fab.hidden = (S.tab === 'more');
  if (animate) staggerIn($('#tab-' + S.tab));
}

function renderHeader() {
  $('#portal-personal').classList.toggle('active', S.portal === 'personal');
  $('#portal-business').classList.toggle('active', S.portal === 'business');
  syncSegmented($('#portal-switch'));
  var cap = $('#portal-caption');
  if (cap) cap.textContent = portalName() + ' khata';
  var chip = $('#user-chip');
  chip.innerHTML = (S.user.picture ? '<img class="chip-avatar" src="' + esc(S.user.picture) + '" alt="" referrerpolicy="no-referrer">' : avatarHTML(displayName(), '', 'sm')) +
    '<span class="nm">' + esc(displayName()) + '</span>';
}

function entryRow(e, showDate) {
  var t = TYPES[e.type] || TYPES.cash_purchase;
  var f = t.flow;
  var amtCls = (f === 'receivable+' || f === 'receivable-') ? 'in' : (f === 'cash' || f === 'payable+' ? 'out' : '');
  var sign = (f === 'payable-' || f === 'receivable-') ? '− ' : '';
  /* showDate: lists without a day header (e.g. dashboard "Recent entries")
   * show the full date + time so nothing is hidden. */
  var dt = showDate ? fmtDateTime(e.ts) : fmtTime(e.ts);
  var sub = '<span class="e-dt">' + esc(dt) + '</span>' +
    (e.party ? ' · ' + esc(e.party) : '') + ' · ' + esc(t.short);
  return '<button class="entry-row" data-id="' + e.id + '">' +
    '<span class="e-ico t-' + e.type + '">' + icon(t.icon) + '</span>' +
    '<span class="e-main"><span class="e-desc">' + esc(e.desc) + '</span>' +
    '<span class="e-sub">' + sub + '</span></span>' +
    '<span class="e-amt ' + amtCls + '">' + sign + fmtRs(e.amount) + '</span></button>';
}
function bindEntryRows(root) {
  $all('.entry-row', root).forEach(function (r) {
    r.addEventListener('click', function () { openEntryModal(r.dataset.id); });
  });
}

/* ---- dashboard ---- */
function greetWord() {
  var h = +tzParts(Date.now()).hour;
  if (h < 5) return 'Namaste';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function renderDashboard() {
  var root = $('#tab-dashboard');
  var list = portalEntries();
  var periodCtl = segmentedHTML('period-switch', PERIOD_ORDER.map(function (k) { return { v: k, label: PERIODS[k].label }; }), S.period, 'sm');
  var greet = '<div class="greet"><div><h2>' + esc(greetWord()) + ', ' + esc(displayName()) +
    ' <button class="edit-name" id="dash-edit-name" title="Change nickname" aria-label="Change nickname">' + icon('pencil') + '</button></h2>' +
    '<p class="muted">' + esc(portalName()) + ' khata · ' + esc(fmtDate(Date.now())) + '</p></div>' +
    (list.length ? '<div class="period-wrap">' + periodCtl + '</div>' : '') + '</div>';

  var nudge = (!S.profile.nickname && !S.profile.dismissedNudge)
    ? '<div class="nudge" id="nick-nudge">' + icon('sparkle') + '<p><b>Make it yours.</b> Add a nickname so Hisab greets you the way you like.</p>' +
      '<button class="btn small primary" id="nudge-set" type="button">Add nickname</button><button class="x" id="nudge-x" aria-label="Dismiss" type="button">' + icon('x') + '</button></div>'
    : '';

  if (!list.length) {
    root.innerHTML = greet + nudge +
      '<div class="card empty" style="padding:48px 20px"><div class="em-ico">' + icon('book') + '</div>' +
      '<p><b>Your ' + esc(portalName().toLowerCase()) + ' khata is empty</b></p><p>Add your first entry and the analytics will light up here.</p>' +
      '<div class="form-actions" style="justify-content:center;margin-top:18px;flex-wrap:wrap">' +
      '<button class="btn primary" id="dash-first" type="button">' + icon('plus') + 'Add first entry</button>' +
      '<button class="btn ghost" id="dash-sample" type="button">' + icon('sparkle') + 'Try sample data</button></div></div>';
    bindDashCommon();
    $('#dash-first').addEventListener('click', function () { openEntryModal(null); });
    $('#dash-sample').addEventListener('click', loadSampleData);
    return;
  }

  var A = analyze(list, S.period), c = A.cur, pv = A.prev, per = PERIODS[S.period];
  var net = netOutstanding(list);
  var flowNet = c.in - c.out;
  var cmp = pv ? '<span class="muted">vs ' + esc(per.prevLabel) + '</span>' : '<span class="muted">' + esc(per.long) + '</span>';

  /* hero */
  var hero = '<div class="hero span-7">' +
    '<div class="k">' + icon('cart') + 'Spent · ' + esc(per.long) + ' ' + deltaChip(c.spent, pv && pv.spent, false, true) + '</div>' +
    '<div class="v" data-count="' + c.spent + '">' + fmtRs(c.spent) + '</div>' +
    '<div class="sub"><div>Money out<b data-count="' + c.out + '">' + fmtRs(c.out) + '</b></div>' +
    '<div>Money in<b data-count="' + c.in + '">' + fmtRs(c.in) + '</b></div>' +
    '<div>Avg / day<b data-count="' + Math.round(c.spent / Math.max(1, A.w.days)) + '">' + fmtRs(c.spent / Math.max(1, A.w.days)) + '</b></div></div>' +
    '<div class="spark">' + sparkline(A.w.buckets.map(function (b) { return b.spent; })) + '</div></div>';

  /* position (all-time) */
  var sum = net.owe + net.owed, owePct = sum ? net.owe / sum * 100 : 50;
  var netPos = net.owed - net.owe;
  var position = '<div class="panel position span-5"><div class="panel-head"><div><h3>Where you stand</h3><p>Outstanding balances · all time</p></div>' +
    '<button class="link-btn" id="dash-balances" type="button">Details</button></div>' +
    '<div class="nums"><div><div class="k">I owe</div><div class="v neg" data-count="' + net.owe + '">' + fmtRs(net.owe) + '</div></div>' +
    '<div style="text-align:right"><div class="k">Owed to me</div><div class="v pos" data-count="' + net.owed + '">' + fmtRs(net.owed) + '</div></div></div>' +
    (sum ? '<div class="split" role="img" aria-label="I owe ' + fmtRs(net.owe) + ', owed to me ' + fmtRs(net.owed) + '">' +
      (net.owe ? '<i style="width:' + owePct + '%;background:var(--neg)"></i>' : '') +
      (net.owed ? '<i style="width:' + (100 - owePct) + '%;background:var(--pos);animation-delay:.15s"></i>' : '') + '</div>'
      : '<div class="split"></div>') +
    '<div class="net-line"><span>' + (netPos === 0 ? 'All square' : netPos > 0 ? 'Net, others owe you' : 'Net, you owe others') + '</span><b data-count="' + netPos + '" data-fmt="signed">' + (netPos > 0 ? '+' : '') + fmtRs(netPos) + '</b></div></div>';

  /* KPI tiles */
  function kpi(label, ico, color, value, fmt, delta) {
    return '<div class="kpi"><div class="k"><span class="ico" style="background:color-mix(in srgb,' + color + ' 14%,transparent);color:' + color + '">' + icon(ico) + '</span>' + esc(label) + '</div>' +
      '<div class="v" data-count="' + value + '"' + (fmt ? ' data-fmt="' + fmt + '"' : '') + '>' + (fmt === 'n' ? fmtNum(value) : fmt === 'signed' ? (value > 0 ? '+' : '') + fmtRs(value) : fmtRs(value)) + '</div>' +
      '<div class="foot">' + delta + '</div></div>';
  }
  var kpis = '<div class="kpi-grid span-12">' +
    kpi('Money out', 'arrowOut', 'var(--s-out)', c.out, '', deltaChip(c.out, pv && pv.out, false) + cmp) +
    kpi('Money in', 'arrowIn', 'var(--s-in)', c.in, '', deltaChip(c.in, pv && pv.in, true) + cmp) +
    kpi('Net cash flow', 'pulse', flowNet >= 0 ? 'var(--pos)' : 'var(--neg)', flowNet, 'signed', '<span class="muted">' + (flowNet >= 0 ? 'More came in than went out' : 'More went out than came in') + '</span>') +
    kpi('Entries', 'hash', 'var(--t1)', c.count, 'n', deltaChip(c.count, pv && pv.count, null) + cmp) +
    '</div>';

  /* cash flow chart */
  var flow = '<div class="panel span-7"><div class="panel-head"><div><h3>Cash flow</h3><p>' + esc(per.long) + ' · per ' + (A.w.unit === 'day' ? 'day' : 'month') + '</p></div>' +
    '<div class="legend"><span><i style="background:var(--s-in)"></i>Money in</span><span><i style="background:var(--s-out)"></i>Money out</span></div></div>' +
    flowChart('flow-chart', A.w.buckets) + '</div>';

  /* donut */
  var donut = '<div class="panel span-5"><div class="panel-head"><div><h3>Activity by type</h3><p>Tap a type to see its entries</p></div></div>' +
    donutChart('type-donut', c.byType) + '</div>';

  /* top people */
  var bal = computeBalances(list);
  var parties = Object.keys(c.byParty).map(function (k) { return c.byParty[k]; })
    .sort(function (a, b) { return b.volume - a.volume; }).slice(0, 5);
  var maxVol = parties.length ? parties[0].volume : 0;
  var people = '<div class="panel span-4"><div class="panel-head"><div><h3>Top people &amp; shops</h3><p>By amount · ' + esc(per.long.toLowerCase()) + '</p></div></div>' +
    (parties.length ? '<div class="hbars">' + parties.map(function (p, i) {
      var b = bal[p.party] || { payable: 0, receivable: 0 }, meta = [];
      if (b.payable > 0) meta.push('<span class="owe">You owe ' + fmtRs(b.payable) + '</span>');
      if (b.receivable > 0) meta.push('<span class="owed">Owes you ' + fmtRs(b.receivable) + '</span>');
      if (!meta.length) meta.push('Settled');
      return '<button class="hbar" type="button" data-party="' + esc(p.party) + '">' + avatarHTML(p.party) +
        '<span><span class="row"><b>' + esc(p.party) + '</b><span>' + fmtRs(p.volume) + '</span></span>' +
        '<span class="track" style="display:block"><span class="fill" style="display:block;width:' + (p.volume / maxVol * 100) + '%;--i:' + i + '"></span></span>' +
        '<span class="meta" style="display:block">' + p.count + ' entr' + (p.count === 1 ? 'y' : 'ies') + ' · ' + meta.join(' · ') + '</span></span></button>';
    }).join('') + '</div>' : emptyMini('Add a person or shop name to entries to see them here.')) + '</div>';

  /* weekday */
  var weekday = '<div class="panel span-4"><div class="panel-head"><div><h3>Spending by weekday</h3><p>Purchases · ' + esc(per.long.toLowerCase()) + '</p></div></div>' +
    weekdayChart('wd-chart', c.wd) + '</div>';

  /* highlights */
  var busiest = null;
  Object.keys(c.byDay).forEach(function (k) { if (!busiest || c.byDay[k] > busiest.v) busiest = { k: k, v: c.byDay[k] }; });
  var topParty = parties[0];
  var hl = '<div class="panel span-4"><div class="panel-head"><div><h3>Highlights</h3><p>' + esc(per.long) + '</p></div></div><div class="hl-grid">' +
    '<div class="hl"><div class="k">Biggest entry</div><div class="v">' + (c.biggest ? fmtRs(c.biggest.amount) : '—') + '</div><div class="s">' + (c.biggest ? esc(c.biggest.desc) : 'Nothing yet') + '</div></div>' +
    '<div class="hl"><div class="k">Busiest day</div><div class="v">' + (busiest ? fmtRs(busiest.v) : '—') + '</div><div class="s">' + (busiest ? esc(_dtfDate.format(dayStart(busiest.k) + DAY / 2)) : 'No purchases') + '</div></div>' +
    '<div class="hl"><div class="k">Top person / shop</div><div class="v">' + (topParty ? esc(topParty.party) : '—') + '</div><div class="s">' + (topParty ? fmtRs(topParty.volume) + ' · ' + topParty.count + ' entr' + (topParty.count === 1 ? 'y' : 'ies') : 'No names yet') + '</div></div>' +
    '<div class="hl"><div class="k">Cash vs due</div><div class="v">' + (c.spent ? Math.round(c.byType.cash_purchase / c.spent * 100) + '% cash' : '—') + '</div><div class="s">' + (c.spent ? fmtRs(c.byType.due_purchase) + ' bought on due' : 'No purchases') + '</div></div>' +
    '</div></div>';

  /* recent */
  var recent = list.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 5);
  var recentHTML = '<div class="span-12"><div class="section-title" style="margin:4px 4px 10px">Recent entries <button class="link" id="dash-all" type="button">View all</button></div>' +
    '<div class="list-card">' + recent.map(function (e) { return entryRow(e, true); }).join('') + '</div></div>';

  root.innerHTML = greet + nudge +
    '<div class="dash-grid">' + hero + position + kpis + flow + donut + people + weekday + hl + recentHTML + '</div>';

  bindDashCommon();
  $all('#period-switch button').forEach(function (b) {
    b.addEventListener('click', function () {
      S.period = b.getAttribute('data-v');
      saveStr(LS_PERIOD, S.period);
      renderDashboard();
    });
  });
  syncSegmented($('#period-switch'));
  $('#dash-all').addEventListener('click', function () { S.tab = 'entries'; renderAll(true); });
  $('#dash-balances').addEventListener('click', function () { S.tab = 'balances'; renderAll(true); });
  $all('#tab-dashboard .hbar').forEach(function (h) {
    h.addEventListener('click', function () {
      S.filterQ = h.getAttribute('data-party'); S.filterType = 'all'; S.tab = 'entries'; renderAll(true);
    });
  });
  bindEntryRows(root);
  bindColumnChart('flow-chart');
  bindColumnChart('wd-chart');
  bindDonut('type-donut');
  countUp(root);
}
function bindDashCommon() {
  var en = $('#dash-edit-name');
  if (en) en.addEventListener('click', function () { openAccountMenu(true); });
  var ns = $('#nudge-set');
  if (ns && !S.profile.nickname && !S.profile.dismissedNudge) {
    ns.addEventListener('click', function () { openAccountMenu(true); });
    $('#nudge-x').addEventListener('click', function () {
      S.profile.dismissedNudge = true; saveProfile();
      var n = $('#nick-nudge');
      if (n && n.style) { n.style.transition = 'opacity .25s, transform .25s'; n.style.opacity = '0'; n.style.transform = 'translateY(-6px)'; }
      setTimeout(function () { if (n && n.remove) n.remove(); }, 260);
    });
  }
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

/* Toolbar is built once per visit; typing only redraws the list below,
 * so the search box keeps focus naturally. */
function renderEntries() {
  var chips = '<button class="chip' + (S.filterType === 'all' ? ' active' : '') + '" data-f="all">All</button>' +
    TYPE_ORDER.map(function (k) {
      return '<button class="chip t-' + k + (S.filterType === k ? ' active' : '') + '" data-f="' + k + '"><i></i>' + esc(TYPES[k].short) + '</button>';
    }).join('');

  $('#tab-entries').innerHTML =
    '<div class="toolbar"><div class="search">' +
      '<span class="search-ico">' + icon('search') + '</span>' +
      '<input id="entries-search" class="field" type="search" placeholder="Search items, people, notes…" value="' + esc(S.filterQ) + '">' +
      '<button class="clear" id="entries-clear" type="button" aria-label="Clear search"' + (S.filterQ ? '' : ' hidden') + '>' + icon('x') + '</button></div>' +
    '<div class="chip-row">' + chips + '</div></div>' +
    '<div id="entries-list" style="display:flex;flex-direction:column;gap:14px"></div>';

  renderEntryList();

  var search = $('#entries-search');
  search.addEventListener('input', function () {
    S.filterQ = search.value;
    var cl = $('#entries-clear'); if (cl) cl.hidden = !S.filterQ;
    renderEntryList();
  });
  $('#entries-clear').addEventListener('click', function () {
    S.filterQ = ''; search.value = ''; this.hidden = true; renderEntryList();
    if (search.focus) search.focus();
  });
  $all('#tab-entries .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      S.filterType = c.dataset.f;
      $all('#tab-entries .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
      renderEntryList();
    });
  });
}
function renderEntryList() {
  var list = filteredEntries();
  var t = totalsFor(list);
  var groups = {}, order = [];
  list.forEach(function (e) {
    var k = dateKey(e.ts);
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(e);
  });
  var html = '<div class="summary-line"><span class="sl-left"><span class="muted">' + list.length + ' entr' + (list.length === 1 ? 'y' : 'ies') + '</span>' +
    (list.length ? '<button class="link-btn" id="entries-print" type="button">' + icon('printer') + 'Print</button>' : '') + '</span>' +
    '<span class="total">Total ' + fmtRs(t.gross) + '</span></div>';
  if (!list.length) {
    html += portalEntries().length
      ? '<div class="card empty"><div class="em-ico">' + icon('search') + '</div><p><b>Nothing found</b></p><p>Try a different search or filter.</p></div>'
      : '<div class="card empty"><div class="em-ico">' + icon('book') + '</div><p><b>No entries yet</b></p><p>Tap + to record your first one.</p></div>';
  } else {
    order.forEach(function (k) {
      var day = groups[k];
      var dt = totalsFor(day);
      html += '<div class="day-group"><div class="day-head"><span class="d">' + esc(fmtDate(day[0].ts)) + '</span>' +
        '<span class="t">' + fmtRs(dt.gross) + '</span></div><div class="list-card">' +
        day.map(entryRow).join('') + '</div></div>';
    });
  }
  var box = $('#entries-list');
  box.innerHTML = html;
  bindEntryRows(box);
  var pb = $('#entries-print');
  if (pb && list.length) pb.addEventListener('click', function () { openReportModal(reportPresetFromEntries()); });
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
  var sum = totOwe + totOwed, owePct = sum ? totOwe / sum * 100 : 50, netPos = totOwed - totOwe;

  function partyCard(p, amount, cls) {
    return '<button class="party-card" data-party="' + esc(p.party) + '">' + avatarHTML(p.party) +
      '<span class="e-main"><span class="e-desc">' + esc(p.party) + '</span>' +
      '<span class="e-sub">' + p.count + ' entr' + (p.count === 1 ? 'y' : 'ies') + ' · tap to see</span></span>' +
      '<span class="bal ' + cls + '">' + fmtRs(amount) + '</span>' + icon('chev', 'chev') + '</button>';
  }

  var html = '<div class="panel position"><div class="panel-head"><div><h3>' + esc(portalName()) + ' balances</h3><p>Everyone you have open accounts with</p></div>' +
      (list.length ? '<button class="link-btn" id="balances-print" type="button">' + icon('printer') + 'Print</button>' : '') + '</div>' +
      '<div class="nums"><div><div class="k">I owe · total</div><div class="v neg" data-count="' + totOwe + '">' + fmtRs(totOwe) + '</div></div>' +
      '<div style="text-align:right"><div class="k">Owed to me · total</div><div class="v pos" data-count="' + totOwed + '">' + fmtRs(totOwed) + '</div></div></div>' +
      '<div class="split">' + (totOwe ? '<i style="width:' + owePct + '%;background:var(--neg)"></i>' : '') +
      (totOwed ? '<i style="width:' + (100 - owePct) + '%;background:var(--pos);animation-delay:.15s"></i>' : '') + '</div>' +
      '<div class="net-line"><span>' + (netPos === 0 ? 'All square' : netPos > 0 ? 'Net, others owe you' : 'Net, you owe others') + '</span><b>' + (netPos > 0 ? '+' : '') + fmtRs(netPos) + '</b></div></div>' +
    '<div class="section-title">I owe · payables</div>' +
    (oweList.length ? '<div class="list-card">' + oweList.map(function (p) { return partyCard(p, p.payable, 'owe'); }).join('') + '</div>'
                   : '<div class="card empty"><div class="em-ico">' + icon('check') + '</div><p><b>All clear</b></p><p>Nobody to pay right now.</p></div>') +
    '<div class="section-title">Owed to me · receivables</div>' +
    (owedList.length ? '<div class="list-card">' + owedList.map(function (p) { return partyCard(p, p.receivable, 'owed'); }).join('') + '</div>'
                    : '<div class="card empty"><div class="em-ico">' + icon('check') + '</div><p><b>Nothing pending</b></p><p>Nobody owes you right now.</p></div>');

  var root = $('#tab-balances');
  root.innerHTML = html;
  var bp = $('#balances-print');
  if (bp && list.length) bp.addEventListener('click', function () { openReportModal({ period: 'all' }); });
  $all('#tab-balances .party-card').forEach(function (c) {
    c.addEventListener('click', function () {
      S.filterQ = c.dataset.party; S.filterType = 'all'; S.tab = 'entries'; renderAll(true);
    });
  });
  countUp(root);
}

/* ---- more tab ---- */
function renderMore() {
  var u = S.user;
  var html =
    '<div class="card profile-card">' + avatarHTML(displayName(), u.picture, 'lg') +
      '<div class="who"><b>' + esc(displayName()) + '</b><span>' + esc(u.kind === 'google' ? u.id : '@' + u.displayName + ' · device-only') + '</span>' +
      (S.profile.nickname ? '' : '<span style="color:var(--accent)">No nickname yet</span>') + '</div>' +
      '<button class="btn ghost small" id="m-profile" type="button">' + icon('pencil') + 'Edit</button></div>' +

    '<div class="section-title">Appearance</div>' +
    '<div class="card menu-card"><div class="menu-row"><span class="lbl">Theme</span>' +
      segmentedHTML('theme-switch', [{ v: 'system', label: 'Auto', icon: 'monitor' }, { v: 'light', label: 'Light', icon: 'sun' }, { v: 'dark', label: 'Dark', icon: 'moon' }], getTheme(), 'sm') +
    '</div></div>' +

    '<div class="section-title">Print &amp; PDF</div>' +
    '<div class="card menu-card">' +
      '<button class="menu-item" id="m-print"><span class="mi">' + icon('printer') + '</span><span>Print or save as PDF<span class="sub">A clean statement for any period, person or entry type</span></span>' + icon('chev', 'chev') + '</button>' +
    '</div>' +

    '<div class="section-title">Backup — keeps your data safe</div>' +
    '<div class="card menu-card">' +
      '<button class="menu-item" id="m-export"><span class="mi">' + icon('download') + '</span><span>Export backup<span class="sub">Download this account\'s records as a JSON file</span></span>' + icon('chev', 'chev') + '</button>' +
      '<button class="menu-item" id="m-import"><span class="mi">' + icon('upload') + '</span><span>Import backup<span class="sub">Restore this account from a JSON backup file</span></span>' + icon('chev', 'chev') + '</button>' +
    '</div>' +

    '<div class="section-title">Data</div><div class="card menu-card">' +
      '<button class="menu-item" id="m-sample"><span class="mi">' + icon('sparkle') + '</span><span>Load sample entries<span class="sub">Try the app with example data</span></span>' + icon('chev', 'chev') + '</button>' +
      '<button class="menu-item danger-item" id="m-clear"><span class="mi">' + icon('trash') + '</span><span>Clear this portal\'s entries<span class="sub">Deletes all ' + portalName() + ' entries of this account</span></span></button>' +
      '<button class="menu-item" id="m-logout"><span class="mi">' + icon('logout') + '</span><span>Log out<span class="sub">Switch to another account</span></span></button>' +
    '</div>' +

    '<div class="card"><h3>Good to know</h3>' +
    '<p class="fineprint">' + (u.kind === 'google'
      ? 'This account syncs to a private app folder in <b>your own Google Drive</b> — sign in with the same Gmail on any browser or phone and your records (and nickname) come with you. A copy is also kept in this browser, so you can still see your khata offline; changes sync when you are back online.'
      : 'This account\'s records live only in this device\'s browser — they are not synced anywhere, ' +
        'and nobody else on this device can see them. ' +
        'Clearing browser data erases them, so export a backup regularly (above). ' +
        'Logins on this device are family-convenience locks, not bank-grade security.') + '</p>' +
    '<p class="fineprint"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a></p></div>';

  $('#tab-more').innerHTML = html;

  $('#m-profile').addEventListener('click', function () { openAccountMenu(true); });
  $all('#theme-switch button').forEach(function (b) {
    b.addEventListener('click', function () {
      setTheme(b.getAttribute('data-v'));
      $all('#theme-switch button').forEach(function (x) { x.classList.toggle('active', x === b); });
      syncSegmented($('#theme-switch'));
    });
  });
  syncSegmented($('#theme-switch'));
  $('#m-print').addEventListener('click', function () { openReportModal(); });
  $('#m-export').addEventListener('click', exportBackup);
  $('#m-import').addEventListener('click', function () { $('#import-file').click(); });
  $('#m-sample').addEventListener('click', loadSampleData);
  $('#m-logout').addEventListener('click', logout);
  $('#m-clear').addEventListener('click', function () {
    confirmDlg('Clear entries?', 'Delete ALL ' + portalName() +
      ' entries of this account? This cannot be undone — export a backup first.', 'Delete all', function () {
        setPortalEntries([]); renderAll(false); toast('Entries cleared.');
      });
  });
}

/* ---------------- JSON backup: export / import (this account only) ---------------- */
function exportBackup() {
  var payload = {
    app: 'hisab', version: 3, exportedAt: new Date().toISOString(),
    exportedBy: S.user ? accountLabel() : 'unknown',
    profile: { nickname: S.profile.nickname || '' },
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
        if (data.profile && typeof data.profile.nickname === 'string' && data.profile.nickname) {
          S.profile.nickname = cleanNickname(data.profile.nickname);
          saveJSON(profileKey(), S.profile);
        }
        queueDriveSave();
        S.filterQ = ''; S.filterType = 'all';
        renderAll(true);
        toast('Backup imported.');
      });
  };
  reader.readAsText(file);
}

/* ---------------- sample data (for trying the app) ---------------- */
function loadSampleData() {
  confirmDlg('Load samples?', 'Add example entries to the ' + portalName() +
    ' portal so you can explore the analytics?', 'Add samples', function () {
      var now = Date.now(), day = DAY;
      var samples = S.portal === 'personal' ? [
        { d: 'Rice, lentils & oil', a: 2450, p: 'Bhatbhateni', t: 'cash_purchase', off: 0 },
        { d: 'Vegetables', a: 380, p: 'Kalimati vendor', t: 'due_purchase', off: 0 },
        { d: 'Gave Ramesh', a: 5000, p: 'Ramesh', t: 'money_given', off: 1 },
        { d: 'Took from Sita', a: 2000, p: 'Sita', t: 'money_taken', off: 2 },
        { d: 'Paid Kalimati vendor', a: 380, p: 'Kalimati vendor', t: 'paid_back', off: 3 },
        { d: 'Ramesh returned part', a: 1500, p: 'Ramesh', t: 'received_back', off: 4 },
        { d: 'Milk (week)', a: 840, p: 'Dairy', t: 'cash_purchase', off: 5 },
        { d: 'Cooking gas', a: 1910, p: 'Gas depot', t: 'cash_purchase', off: 8 },
        { d: 'Fruits', a: 650, p: 'Kalimati vendor', t: 'due_purchase', off: 10 },
        { d: 'Internet bill', a: 1300, p: 'Worldlink', t: 'cash_purchase', off: 13 },
        { d: 'Milk (week)', a: 840, p: 'Dairy', t: 'cash_purchase', off: 12 },
        { d: 'School stationery', a: 1250, p: 'Pustak Pasal', t: 'due_purchase', off: 17 },
        { d: 'Gave Hari', a: 3000, p: 'Hari', t: 'money_given', off: 20 },
        { d: 'Rice (25kg)', a: 2150, p: 'Bhatbhateni', t: 'cash_purchase', off: 24 },
        { d: 'Hari paid back', a: 3000, p: 'Hari', t: 'received_back', off: 27 },
        { d: 'Groceries', a: 3100, p: 'Bhatbhateni', t: 'cash_purchase', off: 38 },
        { d: 'Electricity', a: 1450, p: 'NEA', t: 'cash_purchase', off: 45 }
      ] : [
        { d: 'Paracetamol stock', a: 8500, p: 'Sharma Suppliers', t: 'due_purchase', off: 0 },
        { d: 'Counter sale float', a: 3200, p: '', t: 'cash_purchase', off: 0 },
        { d: 'Paid Sharma Suppliers', a: 5000, p: 'Sharma Suppliers', t: 'paid_back', off: 1 },
        { d: 'Antibiotics stock', a: 12000, p: 'City Pharma', t: 'due_purchase', off: 2 },
        { d: 'Gave staff advance', a: 10000, p: 'Hari', t: 'money_given', off: 3 },
        { d: 'Loan from Bijay', a: 20000, p: 'Bijay', t: 'money_taken', off: 6 },
        { d: 'Syrups & ORS', a: 6400, p: 'City Pharma', t: 'due_purchase', off: 9 },
        { d: 'Shop rent', a: 18000, p: 'Landlord', t: 'cash_purchase', off: 11 },
        { d: 'Paid City Pharma', a: 12000, p: 'City Pharma', t: 'paid_back', off: 15 },
        { d: 'Hari advance returned', a: 4000, p: 'Hari', t: 'received_back', off: 19 },
        { d: 'Bandages & gloves', a: 4200, p: 'Sharma Suppliers', t: 'cash_purchase', off: 23 },
        { d: 'Electricity', a: 2600, p: 'NEA', t: 'cash_purchase', off: 33 }
      ];
      var list = portalEntries();
      samples.forEach(function (s) {
        list.push({ id: uid(), ts: now - s.off * day - Math.round(Math.random() * 6) * 36e5, type: s.t, desc: s.d,
                    amount: s.a, party: s.p, note: 'sample' });
      });
      setPortalEntries(list);
      S.tab = 'dashboard';
      renderAll(true);
      toast('Sample entries added.');
    });
}

/* =========================================================================
 * Print / Save as PDF — account statements
 *
 * Builds a clean, always-light, A4 statement into #print-root and opens
 * the browser's own print dialog: "Save as PDF" there gives a PDF file,
 * a printer prints it. No PDF library — the browser does the rendering.
 *
 * While a statement is armed (body.print-report), print CSS shows only
 * #print-root. It stays armed until logout on purpose: Android Chrome can
 * render its print preview after window.print() has already returned, so
 * tearing it down on 'afterprint' could print the app instead.
 * ========================================================================= */
var REPORT_PERIODS = {
  month: 'This month', lastmonth: 'Last month', '30d': 'Last 30 days',
  '3m': 'Last 3 months', year: 'This year', all: 'All time', custom: 'Custom dates'
};
/* Last-used statement options (kept for the session). */
var RPT = { portal: 'personal', period: 'month', from: '', to: '', party: '', type: 'all', q: '',
            summary: true, balances: true, sign: false };
var _dtfDay = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
function fmtDay(ts) { return _dtfDay.format(ts); }            // "28 Sept 2026"
var _titleBeforePrint = null;

/* Period -> { start, end (exclusive), first, last, label, name } on the Kathmandu calendar. */
function reportRange(o) {
  var today = todayKey(), t0 = dayStart(today), mk = thisMonthKey();
  var r = { start: null, end: null };
  if (o.period === 'month') { r.start = dayStart(mk + '-01'); r.end = t0 + DAY; }
  else if (o.period === 'lastmonth') { r.start = dayStart(shiftMonth(mk, -1) + '-01'); r.end = dayStart(mk + '-01'); }
  else if (o.period === '30d') { r.start = t0 - 29 * DAY; r.end = t0 + DAY; }
  else if (o.period === '3m') { r.start = dayStart(shiftMonth(mk, -2) + '-01'); r.end = t0 + DAY; }
  else if (o.period === 'year') { r.start = dayStart(today.slice(0, 4) + '-01-01'); r.end = t0 + DAY; }
  else if (o.period === 'custom') {
    var re = /^\d{4}-\d{2}-\d{2}$/;
    var f = re.test(o.from) ? o.from : '', t = re.test(o.to) ? o.to : '';
    if (!f && !t) return { error: 'Pick a From or To date for the custom period.' };
    if (f && t && f > t) { var sw = f; f = t; t = sw; }
    r.start = f ? dayStart(f) : null;
    r.end = t ? dayStart(t) + DAY : null;
  }
  /* Open-ended sides borrow the first / last entry (or today) for the label. */
  var first = r.start, last = r.end != null ? r.end - 1 : Date.now();
  (S.entries[o.portal] || []).forEach(function (e) {
    if (o.party && e.party !== o.party) return;
    if (r.start == null && (first == null || e.ts < first)) first = e.ts;
    if (r.end == null && e.ts > last) last = e.ts;
  });
  r.first = first; r.last = last;
  r.label = (first != null ? fmtDay(first) : 'Start') + ' – ' + fmtDay(last);
  r.name = REPORT_PERIODS[o.period] || 'All time';
  return r;
}
function reportMatches(e, o) {
  if (o.party && e.party !== o.party) return false;
  if (o.type !== 'all' && e.type !== o.type) return false;
  var q = String(o.q || '').trim().toLowerCase();
  if (q && (e.desc || '').toLowerCase().indexOf(q) === -1 &&
      (e.party || '').toLowerCase().indexOf(q) === -1 &&
      (e.note || '').toLowerCase().indexOf(q) === -1) return false;
  return true;
}
function reportRows(o, r) {
  return (S.entries[o.portal] || []).filter(function (e) {
    return (r.start == null || e.ts >= r.start) && (r.end == null || e.ts < r.end) && reportMatches(e, o);
  }).sort(function (a, b) { return a.ts - b.ts; });
}
/* Running balance with one person: + they owe me more, − I owe them more. */
function balanceEffect(e) {
  var f = TYPES[e.type] ? TYPES[e.type].flow : 'cash';
  if (f === 'receivable+' || f === 'payable-') return e.amount;
  if (f === 'receivable-' || f === 'payable+') return -e.amount;
  return 0;
}
function balanceWords(n) {
  if (!n) return 'Settled';
  return fmtRs(Math.abs(n)) + '<small>' + (n > 0 ? 'owes you' : 'you owe') + '</small>';
}
var TYPE_EFFECT = {
  cash_purchase: 'Money out', due_purchase: 'On due — I owe',
  money_given: 'Money out — they owe me', money_taken: 'Money in — I owe',
  paid_back: 'Money out — I owe less', received_back: 'Money in — they owe less'
};

function buildReportHTML(o, r) {
  var rows = reportRows(o, r);
  var st = blankStats(), cnt = {};
  TYPE_ORDER.forEach(function (k) { cnt[k] = 0; });
  rows.forEach(function (e) { addToStats(st, e); if (cnt[e.type] != null) cnt[e.type]++; });
  var portal = o.portal === 'business' ? 'Business' : 'Personal';
  var q = String(o.q || '').trim();
  var running = !!(o.party && o.type === 'all' && !q);
  var sub = S.user.kind === 'google' ? S.user.id : (S.profile.nickname ? '@' + S.user.displayName : 'Device-only account');
  var filters = [];
  if (o.party) filters.push('Person / shop: <b>' + esc(o.party) + '</b>');
  if (o.type !== 'all') filters.push('Type: <b>' + esc(TYPES[o.type].label) + '</b>');
  if (q) filters.push('Contains: <b>“' + esc(q) + '”</b>');

  /* header */
  var html = '<article class="rp">' +
    '<header class="rp-head"><div class="rp-brand"><img src="assets/logo.svg" alt="" width="38" height="38"><div><b>Hisab</b><span>Khata book</span></div></div>' +
    '<div class="rp-title"><h1>' + (o.party ? 'Account statement' : esc(portal) + ' khata statement') + '</h1>' +
    '<p>' + (o.party ? esc(o.party) + ' · ' : '') + esc(r.label) + '</p></div></header>' +
    '<dl class="rp-meta">' +
      '<div><dt>Account</dt><dd>' + esc(displayName()) + '<small>' + esc(sub) + '</small></dd></div>' +
      '<div><dt>Khata</dt><dd>' + esc(portal) + '</dd></div>' +
      '<div><dt>Period</dt><dd>' + esc(r.name) + '<small>' + esc(r.label) + '</small></dd></div>' +
      '<div><dt>Filters</dt><dd>' + (filters.length ? filters.join('<br>') : 'None — every entry') + '</dd></div>' +
    '</dl>';

  /* summary */
  if (o.summary) {
    var netFlow = st.in - st.out;
    var tile = function (k, v, s) {
      return '<div class="rp-tile"><span>' + k + '</span><b>' + v + '</b>' + (s ? '<small>' + s + '</small>' : '') + '</div>';
    };
    html += '<section class="rp-sec rp-keep"><h2>Summary</h2><div class="rp-tiles">' +
      tile('Money out', fmtRs(st.out), 'Cash paid, given or paid back') +
      tile('Money in', fmtRs(st.in), 'Cash taken or received back') +
      tile('Net cash flow', (netFlow > 0 ? '+' : '') + fmtRs(netFlow), netFlow > 0 ? 'More came in than went out' : netFlow < 0 ? 'More went out than came in' : 'In and out are equal') +
      tile('Bought on due', fmtRs(st.byType.due_purchase), 'Purchases made on credit') +
      tile('Spent on purchases', fmtRs(st.spent), 'Cash + on due') +
      tile('Entries', fmtNum(st.count), '') +
      '</div>' +
      '<table class="rp-table"><thead><tr><th>Type</th><th class="n">Entries</th><th class="n">Amount</th><th>Effect</th></tr></thead><tbody>' +
      TYPE_ORDER.map(function (k) {
        return '<tr' + (cnt[k] ? '' : ' class="zero"') + '><td><i class="rp-dot ' + TYPES[k].color + '"></i>' + esc(TYPES[k].label) + '</td>' +
          '<td class="n">' + cnt[k] + '</td><td class="n">' + fmtRs(st.byType[k]) + '</td><td>' + esc(TYPE_EFFECT[k]) + '</td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td>Total</td><td class="n">' + st.count + '</td><td class="n">' + fmtRs(st.volume) + '</td><td></td></tr></tfoot></table></section>';
  }

  /* entries — oldest first, one amount column per cash effect */
  html += '<section class="rp-sec"><h2>Entries<small>' + rows.length + ' · oldest first · amounts in Rs</small></h2>';
  if (!rows.length) {
    html += '<p class="rp-empty">No entries match this period and these filters.</p>';
  } else {
    var lead = o.party ? 3 : 4;   // columns before the amount columns
    var bal = 0;
    if (running && r.start != null) {
      (S.entries[o.portal] || []).forEach(function (e) { if (e.party === o.party && e.ts < r.start) bal += balanceEffect(e); });
    }
    html += '<table class="rp-table"><thead><tr><th class="d">Date</th><th>Particulars</th>' + (o.party ? '' : '<th>Person / shop</th>') +
      '<th>Type</th><th class="n">Money out</th><th class="n">Money in</th><th class="n">On due</th>' + (running ? '<th class="n">Balance</th>' : '') + '</tr></thead><tbody>';
    if (running && r.start != null) {
      html += '<tr class="rp-open"><td colspan="' + (lead + 3) + '">Opening balance before ' + esc(fmtDay(r.start)) + '</td><td class="n rb">' + balanceWords(bal) + '</td></tr>';
    }
    var tot = { o: 0, i: 0, d: 0 };
    rows.forEach(function (e) {
      var col = IS_OUT[e.type] ? 'o' : IS_IN[e.type] ? 'i' : 'd';
      tot[col] += e.amount;
      bal += balanceEffect(e);
      var note = (e.note && e.note !== 'sample') ? '<small>' + esc(e.note) + '</small>' : '';
      html += '<tr><td class="d">' + esc(fmtDay(e.ts)) + '<small>' + esc(fmtTime(e.ts)) + '</small></td>' +
        '<td>' + esc(e.desc) + note + '</td>' +
        (o.party ? '' : '<td>' + (e.party ? esc(e.party) : '<span class="rp-mute">—</span>') + '</td>') +
        '<td>' + esc((TYPES[e.type] || TYPES.cash_purchase).label) + '</td>' +
        '<td class="n o">' + (col === 'o' ? fmtNum(e.amount) : '') + '</td>' +
        '<td class="n i">' + (col === 'i' ? fmtNum(e.amount) : '') + '</td>' +
        '<td class="n">' + (col === 'd' ? fmtNum(e.amount) : '') + '</td>' +
        (running ? '<td class="n rb">' + balanceWords(bal) + '</td>' : '') + '</tr>';
    });
    html += '</tbody><tfoot><tr><td colspan="' + lead + '">Total · ' + rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') + '</td>' +
      '<td class="n">' + fmtNum(tot.o) + '</td><td class="n">' + fmtNum(tot.i) + '</td><td class="n">' + fmtNum(tot.d) + '</td>' +
      (running ? '<td class="n rb">' + balanceWords(bal) + '</td>' : '') + '</tr></tfoot></table>';
  }
  html += '</section>';

  /* outstanding balances as of the period end (all entry types) */
  if (o.balances) {
    var upto = (S.entries[o.portal] || []).filter(function (e) {
      return (r.end == null || e.ts < r.end) && (!o.party || e.party === o.party);
    });
    var b = computeBalances(upto), owe = [], owed = [];
    Object.keys(b).forEach(function (k) {
      if (b[k].payable > 0) owe.push(b[k]);
      if (b[k].receivable > 0) owed.push(b[k]);
    });
    owe.sort(function (x, y) { return y.payable - x.payable; });
    owed.sort(function (x, y) { return y.receivable - x.receivable; });
    var totOwe = owe.reduce(function (s, x) { return s + x.payable; }, 0);
    var totOwed = owed.reduce(function (s, x) { return s + x.receivable; }, 0);
    var net = totOwed - totOwe;
    var balTable = function (title, list, key, total) {
      if (!list.length) return '<div><h3>' + title + '</h3><p class="rp-empty">Nothing</p></div>';
      return '<div><h3>' + title + '</h3><table class="rp-table"><thead><tr><th>Name</th><th class="n">Amount</th></tr></thead><tbody>' +
        list.map(function (p) { return '<tr><td>' + esc(p.party) + '</td><td class="n">' + fmtRs(p[key]) + '</td></tr>'; }).join('') +
        '</tbody><tfoot><tr><td>Total</td><td class="n">' + fmtRs(total) + '</td></tr></tfoot></table></div>';
    };
    html += '<section class="rp-sec rp-keep"><h2>Outstanding balances<small>as of ' + esc(fmtDay(r.last)) + ' · all entry types</small></h2>';
    if (!owe.length && !owed.length) {
      html += '<p class="rp-empty">' + (o.party ? esc(o.party) + ' is settled' : 'Everyone is settled') + ' — nothing owed either way.</p>';
    } else {
      html += '<div class="rp-bal">' + balTable('I owe · payables', owe, 'payable', totOwe) + balTable('Owed to me · receivables', owed, 'receivable', totOwed) + '</div>' +
        '<p class="rp-net"><span>' + (net === 0 ? 'All square' : net > 0 ? 'Net, others owe you' : 'Net, you owe others') + '</span><b>' + fmtRs(Math.abs(net)) + '</b></p>';
    }
    html += '</section>';
  }

  if (o.sign) html += '<div class="rp-sign"><div>Prepared by</div><div>Checked by</div><div>Date</div></div>';
  html += '<footer class="rp-foot">Printed from Hisab on ' + esc(fmtDateTime(Date.now())) + ' (Nepal time) · Amounts in Nepali rupees</footer></article>';
  return html;
}

/* Browsers use the page title as the suggested PDF file name. */
function reportFileTitle(o, r) {
  var parts = ['Hisab', o.portal === 'business' ? 'Business' : 'Personal'];
  if (o.party) parts.push(o.party);
  parts.push('statement', (r.first != null ? dateKey(r.first) : 'start') + ' to ' + dateKey(r.last));
  return parts.join(' - ').replace(/[\\/:*?"<>|]+/g, ' ');
}

/* Options sheet */
function fillReportParties() {
  var seen = {}, names = [];
  (S.entries[RPT.portal] || []).forEach(function (e) {
    if (e.party && !seen[e.party]) { seen[e.party] = 1; names.push(e.party); }
  });
  names.sort(function (a, b) { return a.localeCompare(b); });
  if (RPT.party && !seen[RPT.party]) RPT.party = '';
  var sel = $('#r-party');
  sel.innerHTML = '<option value="">Everyone</option>' + names.map(function (n) {
    return '<option value="' + esc(n) + '">' + esc(n) + '</option>';
  }).join('');
  sel.value = RPT.party;
}
function readReportForm() {
  RPT.portal = $('#r-portal').value === 'business' ? 'business' : 'personal';
  RPT.period = REPORT_PERIODS[$('#r-period').value] ? $('#r-period').value : 'month';
  RPT.from = $('#r-from').value || '';
  RPT.to = $('#r-to').value || '';
  RPT.party = $('#r-party').value || '';
  RPT.type = TYPES[$('#r-type').value] ? $('#r-type').value : 'all';
  RPT.q = $('#r-q').value || '';
  RPT.summary = !!$('#r-summary').checked;
  RPT.balances = !!$('#r-balances').checked;
  RPT.sign = !!$('#r-sign').checked;
}
function updateReportUI() {
  $('#r-custom').hidden = RPT.period !== 'custom';
  var hint = $('#r-count'), r = reportRange(RPT);
  if (r.error) { hint.textContent = r.error; return; }
  var n = reportRows(RPT, r).length;
  hint.textContent = (n ? n + ' entr' + (n === 1 ? 'y' : 'ies') : 'No entries') + ' · ' + r.label +
    (RPT.party && RPT.type === 'all' && !RPT.q.trim() ? ' · with running balance' : '');
}
function onReportFormChange() {
  var prevPortal = RPT.portal;
  readReportForm();
  if (RPT.portal !== prevPortal) fillReportParties();
  updateReportUI();
}
/* From the Entries tab: carry over its type filter, and turn a search
 * that exactly names a person/shop into a proper person statement. */
function reportPresetFromEntries() {
  var q = S.filterQ.trim(), party = '';
  if (q) portalEntries().some(function (e) {
    if (e.party && e.party.toLowerCase() === q.toLowerCase()) { party = e.party; return true; }
    return false;
  });
  return { type: S.filterType, party: party, q: party ? '' : q, period: party ? 'all' : null };
}
function openReportModal(preset) {
  if (!S.user) return;
  preset = preset || {};
  RPT.portal = S.portal;
  RPT.party = preset.party || '';
  RPT.type = (preset.type && TYPES[preset.type]) ? preset.type : 'all';
  RPT.q = preset.q || '';
  if (preset.period) RPT.period = preset.period;
  if (!RPT.from) RPT.from = thisMonthKey() + '-01';
  if (!RPT.to) RPT.to = todayKey();
  $('#r-portal').value = RPT.portal;
  $('#r-period').value = RPT.period;
  $('#r-from').value = RPT.from;
  $('#r-to').value = RPT.to;
  fillReportParties();
  $('#r-type').innerHTML = '<option value="all">All types</option>' + TYPE_ORDER.map(function (k) {
    return '<option value="' + k + '">' + esc(TYPES[k].label) + '</option>';
  }).join('');
  $('#r-type').value = RPT.type;
  $('#r-q').value = RPT.q;
  $('#r-summary').checked = RPT.summary;
  $('#r-balances').checked = RPT.balances;
  $('#r-sign').checked = RPT.sign;
  updateReportUI();
  openModal('#report-modal');
}

/* Build the statement, then hand it to the browser's print dialog.
 * window.print() is called directly inside the tap handler — iOS and
 * some Android browsers ignore it outside a user gesture. */
function printReport(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  readReportForm();
  var r = reportRange(RPT);
  if (r.error) { toast(r.error); return; }
  if (typeof window.print !== 'function') { toast('This browser can\'t print. Open Hisab in Chrome or Safari.'); return; }
  $('#print-root').innerHTML = buildReportHTML(RPT, r);
  document.body.classList.add('print-report');
  if (_titleBeforePrint === null) _titleBeforePrint = document.title;
  document.title = reportFileTitle(RPT, r);
  var m = $('#report-modal');
  if (m.classList) m.classList.remove('open');
  m.hidden = true;
  try { window.print(); }
  catch (e) { toast('Printing didn\'t start. Try Chrome or Safari.'); }
}
function restoreTitleAfterPrint() {
  if (_titleBeforePrint === null) return;
  setTimeout(function () {
    if (_titleBeforePrint !== null) { document.title = _titleBeforePrint; _titleBeforePrint = null; }
  }, 1500);
}
/* On logout: drop the statement so the next person can't print it. */
function clearPrintedReport() {
  var pr = $('#print-root');
  if (pr) pr.innerHTML = '';
  if (document.body && document.body.classList) document.body.classList.remove('print-report');
  if (_titleBeforePrint !== null) { document.title = _titleBeforePrint; _titleBeforePrint = null; }
}

/* ---------------- entry modal (add / edit) ---------------- */
function openEntryModal(id) {
  S.editingId = id || null;
  var e = id ? getEntry(id) : null;
  S.entryType = e ? e.type : (S.filterType !== 'all' && S.tab === 'entries' ? S.filterType : 'cash_purchase');
  $('#entry-modal-title').textContent = e ? 'Edit entry' : 'New entry';
  $('#entry-delete').hidden = !e;
  renderTypeGrid();
  $('#f-desc').value = e ? e.desc : '';
  $('#f-amount').value = e ? e.amount : '';
  $('#f-when').value = e ? inputValueFromTs(e.ts) : inputNow();
  $('#f-party').value = e ? e.party : '';
  $('#f-note').value = e && e.note !== 'sample' ? e.note : '';
  var seen = {}, opts = '';
  portalEntries().forEach(function (x) { if (x.party && !seen[x.party]) { seen[x.party] = 1; opts += '<option value="' + esc(x.party) + '">'; } });
  $('#party-list').innerHTML = opts;
  updatePartyLabel();
  openModal('#entry-modal');
  setTimeout(function () { var a = $('#f-amount'); if (a && a.focus) a.focus(); }, 280);
}
/* datetime-local value from an epoch ts (Kathmandu wall clock) */
function inputValueFromTs(ts) {
  var p = tzParts(ts);
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
}
function renderTypeGrid() {
  $('#type-grid').innerHTML = TYPE_ORDER.map(function (k) {
    var t = TYPES[k];
    return '<button type="button" class="type-btn t-' + k + (S.entryType === k ? ' active' : '') + '" data-t="' + k + '">' +
      '<span class="e-ico t-' + k + '">' + icon(t.icon) + '</span><span>' + esc(t.label) + '</span></button>';
  }).join('');
  $all('#type-grid .type-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      S.entryType = b.dataset.t;
      $all('#type-grid .type-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
      updatePartyLabel();
    });
  });
}
function updatePartyLabel() {
  $('#f-party-label').textContent = TYPES[S.entryType].partyLabel;
}
function closeEntryModal() { closeModal('#entry-modal'); S.editingId = null; }

function handleEntrySubmit(ev) {
  ev.preventDefault();
  var desc = $('#f-desc').value.trim();
  var amount = Number($('#f-amount').value);
  if (!(amount > 0)) { toast('Enter an amount greater than 0.'); return; }
  if (!desc) { toast('Add a short description.'); return; }
  var data = {
    ts: tsFromInput($('#f-when').value),
    type: S.entryType, desc: desc, amount: amount,
    party: $('#f-party').value.trim(), note: $('#f-note').value.trim()
  };
  if (S.editingId) { updateEntry(S.editingId, data); toast('Entry updated.'); }
  else { addEntry(data); toast('Saved — ' + fmtRs(data.amount) + '.'); }
  closeEntryModal();
  renderAll(false);
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

  $('#portal-personal').addEventListener('click', function () { if (S.portal !== 'personal') { S.portal = 'personal'; renderAll(true); } });
  $('#portal-business').addEventListener('click', function () { if (S.portal !== 'business') { S.portal = 'business'; renderAll(true); } });

  $all('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (S.tab === b.dataset.tab) { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {} return; }
      S.tab = b.dataset.tab; renderAll(true);
      try { window.scrollTo(0, 0); } catch (e) {}
    });
  });

  $('#fab').addEventListener('click', function () { openEntryModal(null); });
  $('#user-chip').addEventListener('click', function () { openAccountMenu(false); });
  $('#account-close').addEventListener('click', closeAccountMenu);
  $('#account-modal').addEventListener('click', function (ev) { if (ev.target === this) closeAccountMenu(); });
  $('#nickname-form').addEventListener('submit', handleNicknameSave);
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

  var rf = $('#report-form');
  if (rf) {
    rf.addEventListener('submit', printReport);
    rf.addEventListener('change', onReportFormChange);
    rf.addEventListener('input', onReportFormChange);
  }
  $('#report-close').addEventListener('click', function () { closeModal('#report-modal'); });
  $('#report-cancel').addEventListener('click', function () { closeModal('#report-modal'); });
  $('#report-modal').addEventListener('click', function (ev) { if (ev.target === this) closeModal('#report-modal'); });
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('afterprint', restoreTitleAfterPrint);

  $('#entry-form').addEventListener('submit', handleEntrySubmit);
  $('#entry-close').addEventListener('click', closeEntryModal);
  $('#entry-cancel').addEventListener('click', closeEntryModal);
  $('#entry-delete').addEventListener('click', function () {
    var e = S.editingId ? getEntry(S.editingId) : null;
    if (!e) return;
    confirmDlg('Delete entry?', '"' + e.desc + '" — ' + fmtRs(e.amount) + ' · ' + fmtDateTime(e.ts), 'Delete', function () {
      deleteEntry(e.id);
      closeEntryModal();
      renderAll(false);
      toast('Entry deleted.');
    });
  });
  $('#entry-modal').addEventListener('click', function (ev) { if (ev.target === this) closeEntryModal(); });

  $('#confirm-no').addEventListener('click', function () { closeModal('#confirm-modal'); _confirmCb = null; });
  $('#confirm-yes').addEventListener('click', function () {
    closeModal('#confirm-modal');
    var cb = _confirmCb; _confirmCb = null;
    if (cb) cb();
  });
  $('#confirm-modal').addEventListener('click', function (ev) { if (ev.target === this) { closeModal('#confirm-modal'); _confirmCb = null; } });

  /* Esc closes the top-most sheet. */
  if (document.addEventListener) document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (!$('#confirm-modal').hidden) { closeModal('#confirm-modal'); _confirmCb = null; }
    else if (!$('#entry-modal').hidden) closeEntryModal();
    else if (!$('#report-modal').hidden) closeModal('#report-modal');
    else if (!$('#account-modal').hidden) closeAccountMenu();
  });

  /* Keep the Auto theme in step with the OS while the app is open. */
  try {
    var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (getTheme() === 'system') applyTheme('system'); });
  } catch (e) {}

  $('#import-file').addEventListener('change', function () {
    if (this.files && this.files[0]) importBackup(this.files[0]);
    this.value = '';
  });

  boot();
});
