// All in One — keeps the Mac and iPhone in step through the user's own Google Drive.
// Records and documents are encrypted on the device with the sync passphrase before upload, and stored in
// Drive's hidden app-data area (not in the Drive file list; only this app can read it).
// Every record carries a last-changed time: when two devices changed the same record, the newer change wins.
(function () {
  'use strict';

  // OAuth client ID from the user's Google Cloud project (an ID, not a secret). Empty = sync not set up yet.
  const GOOGLE_CLIENT_ID = '100862546755-knl10kmg6sepia8qm6usg007j65o8sks.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const META_FILE = 'sync-meta.json';
  const STATE_FILE = 'state.enc';
  const BLOB_PREFIX = 'blob-';
  const CHECK_TEXT = 'all-in-one-sync-ok';
  const PBKDF2_ITERATIONS = 600000;
  const TOMBSTONE_DAYS = 180;
  const DOC_KEY = '__docs';
  const DAY = 24 * 60 * 60 * 1000;
  // Device-only preferences that should not follow the records around
  const LOCAL_ONLY_KEYS = new Set(['privacyMode']);
  // App settings sync one field at a time (key "#settings.<field>"), so two devices changing different
  // settings both keep their change. These fields are display preferences for one device and don't sync.
  const SETTINGS_PREFIX = '#settings.';
  const LOCAL_ONLY_SETTINGS = new Set(['defaultTab', 'watermarkVisible', 'watermarkOpacity']);
  // Values synced as a whole rather than record by record
  const WHOLE_VALUE_KEYS = new Set(['settings', 'rheumatologyJoints', 'deletedSpecialties', 'customSpecialties', 'removedCustomSpecialties']);
  // Lists that two devices may both change before syncing: combined instead of one device's copy winning.
  // Deleting a built-in specialty is permanent, so those lists only grow. Custom specialties are kept unless
  // removed after they were created (removedCustomSpecialties notes when each name was deleted).
  // Every combiner returns the same order on every device; otherwise two devices holding the same set in
  // different orders would each "fix" the other's upload, forever
  const COMBINE = {
    deletedSpecialties: (a, b) => [...new Set([...(a || []), ...(b || [])])].sort(),
    removedCustomSpecialties: (a, b) => {
      const at = new Map();
      [...(a || []), ...(b || [])].forEach(x => { if (x && x.name) at.set(x.name, Math.max(at.get(x.name) || 0, x.at || 0)); });
      return [...at].map(([name, t]) => ({ name, at: t })).sort((x, y) => x.name.localeCompare(y.name));
    },
    customSpecialties: (a, b) => {
      // Same name on both devices: the earlier-created copy wins, then the smaller JSON text (a fixed tie-break)
      const byName = new Map();
      [...(a || []), ...(b || [])].forEach(c => {
        if (!c || !c.name) return;
        const prev = byName.get(c.name);
        if (!prev) return byName.set(c.name, c);
        const pt = Date.parse(prev.createdAt || '') || 0, ct = Date.parse(c.createdAt || '') || 0;
        if (ct < pt || (ct === pt && JSON.stringify(c) < JSON.stringify(prev))) byName.set(c.name, c);
      });
      return [...byName.values()].sort((x, y) => ((Date.parse(x.createdAt || '') || 0) - (Date.parse(y.createdAt || '') || 0)) || x.name.localeCompare(y.name));
    }
  };
  // Windows that don't hold half-typed record edits, so syncing underneath them is safe
  const NON_BLOCKING_MODALS = new Set(['settingsModal', 'documentViewerModal', 'medicalRecycleBinModal']);

  const LS = {
    enabled: 'allinone_sync_enabled',
    token: 'allinone_sync_token',
    shadow: 'allinone_sync_shadow',
    last: 'allinone_sync_last',
    space: 'allinone_sync_space',
    silentAt: 'allinone_sync_silent_at'
  };
  const SS = { oauthState: 'allinone_sync_oauth_state', afterAuth: 'allinone_sync_after_auth', returnTab: 'allinone_sync_return_tab' };

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let signInError = null;
  let appIsReady = false;
  let status = { kind: 'off' };

  /* ---------- small helpers ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsRemove(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function lsJSON(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssRemove(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  function randomHex(n) { return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join(''); }
  function b64(bytes) {
    let s = '';
    const u = new Uint8Array(bytes);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  // Fast non-cryptographic hash, used only to notice which records changed since the last sync
  function hashStr(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  const hashOf = v => hashStr(JSON.stringify(v));
  // Cheap stand-in for a file's identity so its encrypted content id is only computed once
  function fingerprint(s) {
    if (!s) return '';
    const n = s.length, mid = n >> 1;
    return n + ':' + hashStr(s.slice(0, 256) + s.slice(mid, mid + 256) + s.slice(-256));
  }
  function escapeText(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function isOn() { return lsGet(LS.enabled) === '1'; }
  function isConfigured() { return !!GOOGLE_CLIENT_ID; }

  /* ---------- encryption keys (kept on this device, never uploaded) ---------- */
  function openKeyDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('AllInOne_Sync', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function keyStore(mode, fn) {
    const db = await openKeyDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode);
      const req = fn(tx.objectStore('keys'));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  const loadKeys = () => keyStore('readonly', s => s.get('main')).catch(() => null);
  const saveKeys = keys => keyStore('readwrite', s => s.put(keys, 'main'));
  const clearKeys = () => keyStore('readwrite', s => s.delete('main')).catch(() => {});

  async function deriveKeys(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 512));
    const aes = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const hmac = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { aes, hmac };
  }
  async function encryptBytes(keys, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.aes, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }
  async function decryptBytes(keys, data) {
    const u = new Uint8Array(data);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, keys.aes, u.subarray(12)));
  }
  const encryptJSON = (keys, obj) => encryptBytes(keys, enc.encode(JSON.stringify(obj)));
  const decryptJSON = async (keys, data) => JSON.parse(dec.decode(await decryptBytes(keys, data)));
  // Keyed hash of a document's contents: names its Drive file without revealing anything about it
  async function contentId(keys, dataUrl) {
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', keys.hmac, enc.encode(dataUrl)));
    return Array.from(sig.subarray(0, 20), b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- Google sign-in (redirect, so it also works in the iPhone Home Screen app) ---------- */
  function getToken() {
    const t = lsJSON(LS.token);
    return t && t.access_token && t.expires_at > Date.now() ? t.access_token : null;
  }
  function redirectUri() { return location.origin + location.pathname.replace(/[^/]*$/, '') + 'index.html'; }
  function signIn(silent) {
    if (!isConfigured()) return;
    const st = randomHex(16);
    ssSet(SS.oauthState, st);
    if (typeof currentTab !== 'undefined') ssSet(SS.returnTab, currentTab);
    if (silent) lsSet(LS.silentAt, String(Date.now()));
    const p = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state: st
    });
    if (silent) p.set('prompt', 'none');
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
  }
  function captureSignInResult() {
    if (!/[#&](access_token|error)=/.test(location.hash)) return;
    const p = new URLSearchParams(location.hash.slice(1));
    const expected = ssGet(SS.oauthState);
    ssRemove(SS.oauthState);
    history.replaceState(null, '', location.pathname + location.search);
    if (!expected || p.get('state') !== expected) return;
    if (p.get('access_token')) {
      const seconds = Number(p.get('expires_in')) || 3600;
      lsSet(LS.token, JSON.stringify({ access_token: p.get('access_token'), expires_at: Date.now() + seconds * 1000 - 2 * 60 * 1000 }));
    } else {
      signInError = p.get('error') || 'sign-in failed';
    }
  }
  // Google access lasts an hour; renew it quietly when the app opens or comes back to the front
  function maybeSilentSignIn() {
    if (!isOn() || !isConfigured() || getToken() || !navigator.onLine || signInError) return false;
    if (Date.now() - Number(lsGet(LS.silentAt) || 0) < 10 * 60 * 1000) return false;
    if (appIsReady && blockingModalOpen()) return false;
    signIn(true);
    return true;
  }

  /* ---------- Google Drive ---------- */
  class AuthError extends Error {}
  async function api(url, opts = {}) {
    const token = getToken();
    if (!token) throw new AuthError('Not signed in to Google');
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    if (res.status === 401) {
      lsRemove(LS.token);
      throw new AuthError('Google sign-in expired');
    }
    if (!res.ok) throw new Error('Google Drive error ' + res.status);
    return res;
  }
  async function listFiles() {
    const all = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,createdTime,modifiedTime)' });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await (await api(`${DRIVE}/files?${q}`)).json();
      all.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    const byName = new Map();
    all.forEach(f => {
      const prev = byName.get(f.name);
      if (!prev || f.modifiedTime > prev.modifiedTime) byName.set(f.name, f);
    });
    return { all, byName };
  }
  async function download(id) {
    return new Uint8Array(await (await api(`${DRIVE}/files/${id}?alt=media`)).arrayBuffer());
  }
  async function upload(name, bytes, existingId) {
    const type = 'application/octet-stream';
    if (existingId) {
      return (await api(`${UPLOAD}/files/${existingId}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': type }, body: bytes })).json();
    }
    const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
    if (bytes.byteLength <= 4 * 1024 * 1024) {
      const boundary = 'aio' + randomHex(12);
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
        bytes,
        `\r\n--${boundary}--`
      ]);
      return (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
    }
    // Large documents: resumable upload (the simple kinds are limited to 5 MB)
    const start = await api(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
      body: meta
    });
    const location = start.headers.get('Location');
    if (!location) throw new Error('Google Drive did not accept the upload');
    return (await api(location, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes })).json();
  }
  function removeFile(id) { return api(`${DRIVE}/files/${id}`, { method: 'DELETE' }).catch(() => {}); }

  /* ---------- reading this device's records ---------- */
  function isRecordList(name, value) {
    return Array.isArray(value) && !WHOLE_VALUE_KEYS.has(name) &&
      value.every(r => r && typeof r === 'object' && (typeof r.id === 'string' || typeof r.id === 'number'));
  }
  async function readLocal(keys, shadow) {
    const entries = new Map();
    for (const [name, value] of Object.entries(state)) {
      if (LOCAL_ONLY_KEYS.has(name) || value === undefined || name[0] === '#') continue;
      if (name === 'settings' && value && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([f, v]) => { if (!LOCAL_ONLY_SETTINGS.has(f) && v !== undefined) entries.set(SETTINGS_PREFIX + f, v); });
        continue;
      }
      if (isRecordList(name, value)) value.forEach(rec => entries.set(`${name}/${rec.id}`, rec));
      else entries.set('@' + name, value);
    }
    const docs = await getAllStoredDocs();
    const content = {};
    const dataUrls = new Map();
    // Vault preview images are made on each device, so they never sync
    const thumbs = new Map();
    for (const doc of docs) {
      const { dataUrl, thumbUrl, ...meta } = doc;
      if (thumbUrl) thumbs.set(doc.id, thumbUrl);
      const fp = fingerprint(dataUrl);
      const cached = shadow.content && shadow.content[doc.id];
      const c = dataUrl ? (cached && cached.fp === fp ? cached.c : await contentId(keys, dataUrl)) : '';
      content[doc.id] = { fp, c };
      if (dataUrl) dataUrls.set(c, dataUrl);
      entries.set(`${DOC_KEY}/${doc.id}`, { ...meta, _c: c });
    }
    return { entries, content, dataUrls, thumbs };
  }

  /* ---------- settings: from one synced value to one value per field ---------- */
  // Drive copies written by older versions hold settings as one "@settings" value: split it into fields,
  // without overwriting fields a newer version already wrote. Returns true when the Drive copy changed.
  function upgradeRemoteSettings(remote) {
    const old = remote.entries && remote.entries['@settings'];
    if (!old) return false;
    delete remote.entries['@settings'];
    if (old.d && typeof old.d === 'object') {
      Object.entries(old.d).forEach(([f, v]) => {
        const k = SETTINGS_PREFIX + f;
        if (!LOCAL_ONLY_SETTINGS.has(f) && v !== undefined && !remote.entries[k]) remote.entries[k] = { t: old.t, d: v };
      });
    }
    return true;
  }

  // This device's record of the last sync kept only a fingerprint of the whole settings value. Work out what
  // each setting was then: try putting back the Drive copy's value for settings that differ until the
  // fingerprint matches. Settings unchanged on this device since then keep their old time, so a newer
  // change from another device still wins; settings changed here count as new edits.
  function upgradeShadowSettings(shadow, remote) {
    const old = shadow.entries['@settings'];
    if (!old) return;
    delete shadow.entries['@settings'];
    const current = state.settings;
    if (!current || typeof current !== 'object') return;
    const theirs = {}, theirsT = {};
    const whole = remote.entries && remote.entries['@settings'];
    if (whole && whole.d && typeof whole.d === 'object') Object.entries(whole.d).forEach(([f, v]) => { theirs[f] = v; theirsT[f] = whole.t || 0; });
    Object.entries(remote.entries || {}).forEach(([k, e]) => { if (k.startsWith(SETTINGS_PREFIX)) { theirs[k.slice(SETTINGS_PREFIX.length)] = e.d; theirsT[k.slice(SETTINGS_PREFIX.length)] = e.t || 0; } });
    const differing = Object.keys(current).filter(f => f in theirs && hashOf(current[f]) !== hashOf(theirs[f]));
    let base = null;
    if (differing.length <= 12) {
      for (let mask = 0; mask < (1 << differing.length) && !base; mask++) {
        const candidate = { ...current };
        differing.forEach((f, i) => { if (mask & (1 << i)) candidate[f] = theirs[f]; });
        if (hashOf(candidate) === old.h) base = candidate;
      }
    }
    Object.entries(current).forEach(([f, v]) => {
      if (LOCAL_ONLY_SETTINGS.has(f) || v === undefined) return;
      if (base) {
        if (hashOf(v) === hashOf(base[f])) shadow.entries[SETTINGS_PREFIX + f] = { h: hashOf(v), t: old.t };
        return;
      }
      // No match (usually a device-only preference changed too). A field that differs from Drive's copy while
      // Drive hasn't changed it since the last sync can only have been edited here, so it counts as this
      // device's edit; everything else counts as unchanged, so a newer Drive change still wins.
      const differs = f in theirs && hashOf(v) !== hashOf(theirs[f]);
      if (differs && !((theirsT[f] || 0) > old.t)) return;
      shadow.entries[SETTINGS_PREFIX + f] = { h: hashOf(v), t: old.t };
    });
  }

  /* ---------- merging ---------- */
  function merge(local, shadow, remote, joining, now) {
    // Unchanged since the last sync keeps its time; changed or new gets "now".
    // On a device's first sync everything local counts as oldest, so the Drive copy wins where both have a record.
    const L = new Map();
    for (const [key, d] of local.entries) {
      const h = hashOf(d);
      const s = shadow.entries[key];
      L.set(key, { d, h, t: s && s.h === h ? s.t : (joining ? 1 : now) });
    }
    const tombs = { ...(remote.tombs || {}) };
    const addTomb = (k, t) => { if (!tombs[k] || tombs[k] < t) tombs[k] = t; };
    Object.entries(shadow.tombs || {}).forEach(([k, t]) => addTomb(k, t));
    // Synced last time but gone now = deleted on this device
    Object.keys(shadow.entries).forEach(k => { if (!L.has(k)) addTomb(k, now); });
    Object.keys(tombs).forEach(k => { if (now - tombs[k] > TOMBSTONE_DAYS * DAY) delete tombs[k]; });

    const merged = {};
    let remoteChanged = false;
    const remoteEntries = remote.entries || {};
    const keys = new Set([...L.keys(), ...Object.keys(remoteEntries), ...Object.keys(tombs)]);
    for (const k of keys) {
      const l = L.get(k), r = remoteEntries[k];
      let win = l && (!r || l.t > r.t) ? { t: l.t, d: l.d, h: l.h } : r ? { t: r.t, d: r.d } : null;
      if (win && (tombs[k] || 0) >= win.t) win = null;
      if (win) {
        if (!win.h) win.h = hashOf(win.d);
        merged[k] = win;
      }
      if ((r ? r.t : -1) !== (win ? win.t : -1)) remoteChanged = true;
    }
    for (const name of Object.keys(COMBINE)) {
      const k = '@' + name, l = L.get(k), r = remoteEntries[k];
      if (!l || !r || l.h === hashOf(r.d)) continue;
      const d = COMBINE[name](l.d, r.d), h = hashOf(d);
      // Nothing new for Drive when the combined list is exactly what Drive already holds
      if (h === hashOf(r.d)) { merged[k] = { t: r.t, d: r.d, h }; continue; }
      merged[k] = { t: now, d, h };
      remoteChanged = true;
    }
    const removed = merged['@removedCustomSpecialties'], custom = merged['@customSpecialties'];
    if (removed && custom && Array.isArray(custom.d)) {
      const gone = new Map(removed.d.map(x => [x.name, x.at]));
      const kept = custom.d.filter(c => !gone.has(c.name) || Date.parse(c.createdAt || 0) > gone.get(c.name));
      if (kept.length !== custom.d.length) { merged['@customSpecialties'] = { t: now, d: kept, h: hashOf(kept) }; remoteChanged = true; }
    }
    const oldTombs = remote.tombs || {};
    if (Object.keys(tombs).length !== Object.keys(oldTombs).length || Object.keys(tombs).some(k => oldTombs[k] !== tombs[k])) remoteChanged = true;
    return { L, merged, tombs, remoteChanged };
  }

  // Bring this device's records in line with the merged copy; returns true when anything changed
  function applyToState(merged, L) {
    let changed = false;
    const lists = {};
    for (const [k, e] of Object.entries(merged)) {
      if (k.startsWith(DOC_KEY + '/')) continue;
      if (k.startsWith(SETTINGS_PREFIX)) {
        const field = k.slice(SETTINGS_PREFIX.length);
        const l = L.get(k);
        if (!state.settings || typeof state.settings !== 'object') state.settings = {};
        // Changed on this device while the sync was running: keep it, the next pass sends it
        if (l && state.settings[field] !== undefined && hashOf(state.settings[field]) !== l.h) continue;
        if (!l || l.h !== e.h) { state.settings[field] = e.d; changed = true; }
        continue;
      }
      if (k[0] === '@') {
        const name = k.slice(1);
        if (name[0] === '#') continue;
        const l = L.get(k);
        // Changed on this device while the sync was running: keep it, the next pass sends it
        if (l && state[name] !== undefined && hashOf(state[name]) !== l.h) continue;
        if (!l || l.h !== e.h) { state[name] = e.d; changed = true; }
        continue;
      }
      const col = k.slice(0, k.indexOf('/'));
      (lists[col] = lists[col] || new Map()).set(k, e);
    }
    const localCols = [...L.keys()].filter(k => k[0] !== '@' && k[0] !== '#' && !k.startsWith(DOC_KEY + '/')).map(k => k.slice(0, k.indexOf('/')));
    for (const col of new Set([...Object.keys(lists), ...localCols])) {
      const wanted = lists[col] || new Map();
      const current = Array.isArray(state[col]) ? state[col] : [];
      let colChanged = !Array.isArray(state[col]);
      const next = [];
      const seen = new Set();
      // Keep this device's order; update changed records in place, drop deleted ones, add new ones at the end
      for (const rec of current) {
        const k = `${col}/${rec.id}`;
        seen.add(k);
        const e = wanted.get(k);
        const l = L.get(k);
        // Added or edited on this device while the sync was downloading: keep it, the next pass sends it
        if (!l || hashOf(rec) !== l.h) { next.push(rec); continue; }
        if (!e) { colChanged = true; continue; }
        if (l.h === e.h) next.push(rec);
        else { next.push(e.d); colChanged = true; }
      }
      // A record this device had when the sync started but has deleted since stays deleted
      const added = [...wanted].filter(([k]) => !seen.has(k) && !L.has(k)).sort((a, b) => a[1].t - b[1].t);
      added.forEach(([, e]) => next.push(e.d));
      if (added.length) colChanged = true;
      if (colChanged) { state[col] = next; changed = true; }
    }
    return changed;
  }

  // Was this document added, edited or deleted on this device after the sync read it? Then this device's
  // version stays and the next pass sends it.
  async function docChangedLocally(k, l, local) {
    const id = k.slice(DOC_KEY.length + 1);
    const current = await hooks.getDoc(id);
    if (!l) return !!current;
    if (!current) return true;
    const before = local.content[id];
    if (!before || fingerprint(current.dataUrl) !== before.fp) return true;
    const { dataUrl, thumbUrl, ...meta } = current;
    return hashOf({ ...meta, _c: before.c }) !== l.h;
  }

  async function applyDocs(merged, L, local, files, keys, applied) {
    let changed = false;
    for (const [k, e] of Object.entries(merged)) {
      if (!k.startsWith(DOC_KEY + '/')) continue;
      const l = L.get(k);
      if (l && l.h === e.h) continue;
      if (await docChangedLocally(k, l, local)) continue;
      const { _c, ...meta } = e.d;
      let dataUrl = _c ? local.dataUrls.get(_c) : '';
      if (_c && !dataUrl) {
        const f = files.byName.get(BLOB_PREFIX + _c);
        if (!f) throw new Error('A document is still uploading from another device');
        setStatus('syncing', { label: 'Downloading documents…' });
        dataUrl = dec.decode(await decryptBytes(keys, await download(f.id)));
        local.dataUrls.set(_c, dataUrl);
      }
      // Same file as before (only its details changed): keep this device's preview image
      const thumbUrl = local.content[meta.id] && local.content[meta.id].c === _c ? local.thumbs.get(meta.id) : undefined;
      const saved = { ...meta, dataUrl };
      if (thumbUrl) saved.thumbUrl = thumbUrl;
      if (!(await hooks.saveDoc(saved))) throw new Error('This device ran out of storage space');
      local.content[meta.id] = { fp: fingerprint(dataUrl), c: _c };
      applied.add(k);
      changed = true;
    }
    for (const [k, l] of L) {
      if (k.startsWith(DOC_KEY + '/') && !merged[k]) {
        if (await docChangedLocally(k, l, local)) continue;
        const id = k.slice(DOC_KEY.length + 1);
        await hooks.deleteDoc(id);
        delete local.content[id];
        applied.add(k);
        changed = true;
      }
    }
    return changed;
  }

  /* ---------- one sync pass ---------- */
  let running = null;
  let rerun = false;
  let retryTimer = null;

  function syncNow() {
    if (!isOn() || !appIsReady) return Promise.resolve();
    if (running) { rerun = true; return running; }
    running = runSync().finally(() => {
      running = null;
      if (rerun) { rerun = false; setTimeout(syncNow, 500); }
    });
    return running;
  }

  async function runSync() {
    if (blockingModalOpen()) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(syncNow, 5000);
      return;
    }
    if (!navigator.onLine) return setStatus('offline');
    if (!getToken()) return setStatus('signin');
    const keys = await loadKeys();
    if (!keys) {
      // The passphrase key was cleared from this device (e.g. site data removed): sync has to be turned on again.
      // What was last synced is kept, so turning it back on merges instead of letting Drive win everything.
      lsRemove(LS.enabled);
      return setStatus('off');
    }
    setStatus('syncing');
    let appliedState = false;
    try {
      const now = Date.now();
      const files = await listFiles();
      // Devices that turned sync on before this was recorded learn which Drive sync they belong to,
      // so turning sync off and on again later merges instead of starting over
      if (!lsGet(LS.space)) {
        const metaFile = files.byName.get(META_FILE);
        if (metaFile) {
          try {
            const meta = JSON.parse(dec.decode(await download(metaFile.id)));
            if (meta && meta.salt) lsSet(LS.space, meta.salt);
          } catch (e) {}
        }
      }
      const shadowRaw = lsJSON(LS.shadow);
      const joining = !shadowRaw || !shadowRaw.synced;
      const shadow = shadowRaw || { entries: {}, tombs: {}, content: {} };
      if (joining) { shadow.entries = {}; shadow.tombs = {}; }
      const local = await readLocal(keys, shadow);
      const stateFile = files.byName.get(STATE_FILE);
      const remote = stateFile ? await decryptJSON(keys, await download(stateFile.id)) : { entries: {}, tombs: {} };
      upgradeShadowSettings(shadow, remote);
      const remoteUpgraded = upgradeRemoteSettings(remote);

      const result = merge(local, shadow, remote, joining, now);
      const { L, merged, tombs } = result;
      const remoteChanged = result.remoteChanged || remoteUpgraded;

      // A restore started while this pass was downloading: leave everything alone, the page is about to reload
      if (restoreInProgress) return;
      const stateChanged = applyToState(merged, L);
      if (stateChanged && !hooks.saveState()) throw new Error('This device ran out of storage space');
      appliedState = stateChanged;
      const progress = { synced: !joining, space: lsGet(LS.space), entries: {}, tombs, content: shadow.content || {} };
      Object.entries(shadow.entries).forEach(([k, v]) => { if (k.startsWith(DOC_KEY + '/')) progress.entries[k] = v; });
      Object.entries(merged).forEach(([k, e]) => { if (!k.startsWith(DOC_KEY + '/')) progress.entries[k] = { h: e.h, t: e.t }; });
      lsSet(LS.shadow, JSON.stringify(progress));
      if (restoreInProgress) return;
      const appliedDocs = new Set();
      let docsChanged;
      try {
        docsChanged = await applyDocs(merged, L, local, files, keys, appliedDocs);
      } catch (err) {
        // Documents that did arrive are recorded, so the next pass doesn't mistake them for new edits here
        progress.content = { ...progress.content };
        appliedDocs.forEach(k => {
          const id = k.slice(DOC_KEY.length + 1), e = merged[k];
          if (e) { progress.entries[k] = { h: e.h, t: e.t }; if (local.content[id]) progress.content[id] = local.content[id]; }
          else { delete progress.entries[k]; delete progress.content[id]; }
        });
        lsSet(LS.shadow, JSON.stringify(progress));
        throw err;
      }

      // Upload document contents first, so the record list never points at a file that isn't there yet
      const needed = new Set(Object.entries(merged).filter(([k]) => k.startsWith(DOC_KEY + '/')).map(([, e]) => e.d._c).filter(Boolean));
      const missing = [...needed].filter(c => !files.byName.has(BLOB_PREFIX + c));
      for (let i = 0; i < missing.length; i++) {
        const dataUrl = local.dataUrls.get(missing[i]);
        if (!dataUrl) continue;
        setStatus('syncing', { label: `Uploading documents ${i + 1} of ${missing.length}…` });
        await upload(BLOB_PREFIX + missing[i], await encryptBytes(keys, enc.encode(dataUrl)));
      }
      if (remoteChanged || !stateFile) {
        const out = { v: 1, updatedAt: now, entries: {}, tombs };
        Object.entries(merged).forEach(([k, e]) => { out.entries[k] = { t: e.t, d: e.d }; });
        await upload(STATE_FILE, await encryptJSON(keys, out), stateFile && stateFile.id);
      }

      // Tidy up: document files nothing refers to any more (after a day, in case another device is mid-sync)
      for (const f of files.all) {
        const isOldBlob = f.name.startsWith(BLOB_PREFIX) && !needed.has(f.name.slice(BLOB_PREFIX.length)) && now - Date.parse(f.createdTime) > DAY;
        const isDuplicateState = f.name === STATE_FILE && stateFile && f.id !== stateFile.id;
        if (isOldBlob || isDuplicateState) await removeFile(f.id);
      }

      const next = { synced: true, space: lsGet(LS.space), entries: {}, tombs, content: {} };
      Object.entries(merged).forEach(([k, e]) => {
        next.entries[k] = { h: e.h, t: e.t };
        if (k.startsWith(DOC_KEY + '/')) {
          const id = k.slice(DOC_KEY.length + 1);
          if (local.content[id]) next.content[id] = local.content[id];
        }
      });
      lsSet(LS.shadow, JSON.stringify(next));
      lsSet(LS.last, JSON.stringify({ at: Date.now() }));
      setStatus('ok');
      if (stateChanged || docsChanged) refreshApp();
    } catch (e) {
      if (e instanceof AuthError) {
        setStatus('signin');
      } else {
        console.warn('Sync failed:', e);
        setStatus('error', { message: e && e.message ? e.message : String(e) });
      }
      // Records that did arrive before the failure are shown, not left for the next render
      if (appliedState) refreshApp();
    }
  }

  /* ---------- connecting to the app ---------- */
  const hooks = {
    saveState: () => window.saveState(),
    getDoc: id => window.getDocFromDB(id),
    saveDoc: doc => window.saveDocToDB(doc),
    deleteDoc: id => window.deleteDocFromDB(id)
  };
  let hooked = false;
  let changeTimer = null;
  function onLocalChange() {
    if (!isOn()) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(syncNow, 2000);
  }
  // Sync shortly after anything is saved; sync's own writes use the originals so they don't trigger another pass
  function hookApp() {
    if (hooked || typeof window.saveState !== 'function') return;
    hooked = true;
    const saveState = window.saveState, saveDoc = window.saveDocToDB, deleteDoc = window.deleteDocFromDB;
    hooks.saveState = () => saveState();
    hooks.saveDoc = doc => saveDoc(doc);
    hooks.deleteDoc = id => deleteDoc(id);
    window.saveState = function () { const r = saveState.apply(this, arguments); onLocalChange(); return r; };
    window.saveDocToDB = function () { return saveDoc.apply(this, arguments).then(r => { onLocalChange(); return r; }); };
    window.deleteDocFromDB = function () { return deleteDoc.apply(this, arguments).then(r => { onLocalChange(); return r; }); };
  }

  // Set while a backup is being restored: the page reloads when that finishes, and until then no sync
  // pass may read or write records or documents (the in-memory state is still the old one)
  let restoreInProgress = false;
  function setBusy(on) { restoreInProgress = !!on; }

  // Forget what was last synced. Used when records are cleared or a backup is restored while sync is off:
  // when sync is turned on again the device joins afresh, instead of treating every missing record as deleted
  function forgetLastSync() { lsRemove(LS.shadow); }

  function blockingModalOpen() {
    if (restoreInProgress) return true;
    if (document.querySelector('[data-aio-sync-overlay]')) return true;
    return [...document.querySelectorAll('[id$="Modal"]:not(.hidden)')].some(el => !NON_BLOCKING_MODALS.has(el.id));
  }

  function refreshApp() {
    try {
      if (typeof invalidateDocsCache === 'function') invalidateDocsCache();
      if (typeof applySettings === 'function') applySettings();
      if (typeof renderSpecialtyUI === 'function') renderSpecialtyUI();
      if (typeof updateCareteamDatalist === 'function') updateCareteamDatalist();
      if (typeof updateRecycleBinCount === 'function') updateRecycleBinCount();
      if (typeof switchTab === 'function' && typeof currentTab !== 'undefined') switchTab(currentTab);
    } catch (e) {
      console.warn('Could not redraw after sync:', e);
    }
  }

  /* ---------- turning sync on and off ---------- */
  async function turnOn() {
    if (!isConfigured()) return;
    if (!window.crypto || !crypto.subtle) {
      alert('Sync needs a secure connection. Open the app from its usual address and try again.');
      return;
    }
    if (!getToken()) {
      ssSet(SS.afterAuth, 'setup');
      signIn(false);
      return;
    }
    setStatus('syncing', { label: 'Checking Google Drive…' });
    try {
      const files = await listFiles();
      const metaFile = files.byName.get(META_FILE);
      let keys, space = null;
      if (metaFile) {
        const meta = JSON.parse(dec.decode(await download(metaFile.id)));
        space = meta.salt;
        const salt = unb64(meta.salt), check = unb64(meta.check);
        keys = await askPassphrase(false, async pass => {
          const k = await deriveKeys(pass, salt, meta.iterations || PBKDF2_ITERATIONS);
          try {
            return dec.decode(await decryptBytes(k, check)) === CHECK_TEXT ? k : null;
          } catch (e) {
            return null;
          }
        });
      } else {
        keys = await askPassphrase(true, async pass => {
          const salt = crypto.getRandomValues(new Uint8Array(16));
          const k = await deriveKeys(pass, salt, PBKDF2_ITERATIONS);
          const check = await encryptBytes(k, enc.encode(CHECK_TEXT));
          const meta = { format: 'all-in-one-sync', version: 1, iterations: PBKDF2_ITERATIONS, salt: b64(salt), check: b64(check) };
          space = meta.salt;
          await upload(META_FILE, enc.encode(JSON.stringify(meta)));
          return k;
        });
      }
      if (!keys) return setStatus(isOn() ? 'ok' : 'off');
      await saveKeys(keys);
      lsSet(LS.enabled, '1');
      // Same Drive sync as before on this device: keep what was last synced. Anything else starts fresh.
      const previous = lsJSON(LS.shadow);
      if (!previous || !space || previous.space !== space) lsRemove(LS.shadow);
      lsSet(LS.space, space || '');
      hookApp();
      await syncNow();
      if (status.kind === 'ok' && typeof window.showToast === 'function') window.showToast('Sync is on for this device');
    } catch (e) {
      if (e instanceof AuthError) setStatus('signin');
      else setStatus('error', { message: e && e.message ? e.message : String(e) });
    }
  }

  async function turnOff() {
    if (!confirm('Turn off sync on this device?\n\nYour records stay on this device and in Google Drive. Your other devices keep syncing with each other.')) return;
    lsRemove(LS.enabled);
    lsRemove(LS.token);
    // The record of what was last synced stays, so turning sync back on later merges edits made in between
    lsRemove(LS.last);
    await clearKeys();
    setStatus('off');
  }

  // Passphrase window. `isNew` asks twice; `attempt` returns the keys, or null for a wrong passphrase.
  function askPassphrase(isNew, attempt) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-aio-sync-overlay', '');
      overlay.className = 'fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4';
      const input = 'w-full text-sm px-3 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500';
      overlay.innerHTML = `
        <form class="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl p-5 space-y-3">
          <div class="text-center space-y-1">
            <div class="text-3xl"><svg class="ico" aria-hidden="true"><use href="#i-lock"/></svg></div>
            <h3 class="font-bold text-slate-800 dark:text-slate-100">${isNew ? 'Choose a sync passphrase' : 'Enter your sync passphrase'}</h3>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">${isNew
              ? 'Your records are locked with this before they leave the device, so Google can\'t read them. You\'ll type it once on each device. If you forget it, the Drive copy can\'t be opened — but your devices keep their records.'
              : 'Use the passphrase you chose when you turned on sync on your other device.'}</p>
          </div>
          <input type="password" data-pass autocomplete="${isNew ? 'new-password' : 'current-password'}" placeholder="Passphrase (at least 8 characters)" class="${input}">
          ${isNew ? `<input type="password" data-pass2 autocomplete="new-password" placeholder="Type it again" class="${input}">` : ''}
          <p data-error class="hidden text-[11px] font-semibold text-rose-600 dark:text-rose-400"></p>
          <button type="submit" data-ok class="w-full py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-sm">${isNew ? 'Turn on sync' : 'Unlock'}</button>
          <button type="button" data-cancel class="w-full py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold text-xs">Cancel</button>
        </form>`;
      const form = overlay.querySelector('form');
      const err = overlay.querySelector('[data-error]');
      const ok = overlay.querySelector('[data-ok]');
      const showError = msg => { err.textContent = msg; err.classList.remove('hidden'); };
      const finish = keys => { overlay.remove(); resolve(keys); };
      overlay.querySelector('[data-cancel]').onclick = () => finish(null);
      form.onsubmit = async ev => {
        ev.preventDefault();
        const pass = overlay.querySelector('[data-pass]').value;
        if (pass.length < 8) return showError('Use at least 8 characters.');
        if (isNew && pass !== overlay.querySelector('[data-pass2]').value) return showError('The two passphrases don\'t match.');
        ok.disabled = true;
        ok.textContent = isNew ? 'Setting up…' : 'Unlocking…';
        try {
          const keys = await attempt(pass);
          if (keys) return finish(keys);
          showError('That passphrase doesn\'t match. Try again.');
        } catch (e) {
          showError('Something went wrong: ' + (e && e.message ? e.message : e));
        }
        ok.disabled = false;
        ok.textContent = isNew ? 'Turn on sync' : 'Unlock';
      };
      document.body.appendChild(overlay);
      setTimeout(() => overlay.querySelector('[data-pass]').focus(), 50);
    });
  }

  /* ---------- status display (sidebar + Settings) ---------- */
  function lastSyncedText() {
    const last = lsJSON(LS.last);
    if (!last || !last.at) return 'not yet';
    const mins = Math.floor((Date.now() - last.at) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    return new Date(last.at).toLocaleDateString();
  }
  function describe() {
    switch (status.kind) {
      case 'syncing': return { dot: 'bg-indigo-500 animate-pulse', text: status.label || 'Syncing…', side: 'Drive' };
      case 'ok': return { dot: 'bg-emerald-500', text: `Synced ${lastSyncedText()}`, side: 'Drive' };
      case 'offline': return { dot: 'bg-amber-500', text: 'Offline — saved on this device', side: 'Will sync' };
      case 'signin': return { dot: 'bg-amber-500', text: 'Sign in to Google to sync', side: 'Tap' };
      case 'error': return { dot: 'bg-rose-500', text: 'Sync problem — tap to retry', side: 'Tap' };
      default: return { dot: 'bg-emerald-500 animate-pulse', text: 'Saved on this device', side: isConfigured() ? 'Sync off' : 'IndexedDB' };
    }
  }
  function setStatus(kind, extra) {
    status = { kind, ...(extra || {}) };
    renderStatus();
  }
  function renderStatus() {
    const d = describe();
    const dot = document.getElementById('syncStatusDot');
    const text = document.getElementById('syncStatusText');
    const side = document.getElementById('syncStatusSide');
    const btn = document.getElementById('syncStatusBtn');
    if (dot) dot.className = `w-2 h-2 rounded-full shrink-0 ${d.dot}`;
    if (text) text.textContent = d.text;
    if (side) side.textContent = d.side;
    if (btn) btn.title = status.kind === 'error' && status.message ? status.message : d.text;
    renderSettingsCard();
  }
  function statusClicked() {
    if (status.kind === 'signin') return signIn(false);
    if (status.kind === 'error') return syncNow();
    if (window.AllInOne && typeof AllInOne.openSettings === 'function') {
      AllInOne.openSettings('general');
      const card = document.getElementById('syncSettingsCard');
      if (card) setTimeout(() => card.scrollIntoView({ block: 'start', behavior: 'smooth' }), 100);
    }
  }

  function renderSettingsCard() {
    const card = document.getElementById('syncSettingsCard');
    if (!card) return;
    const btn = 'px-4 py-2.5 rounded-xl text-xs font-extrabold transition flex items-center justify-center space-x-2';
    const primary = `${btn} bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm`;
    const secondary = `${btn} bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-400 text-slate-700 dark:text-slate-200`;
    let body;
    if (!isConfigured()) {
      body = `<p class="text-[11px] text-slate-500 dark:text-slate-400">Sync isn't set up yet. It needs a one-time Google setup.</p>`;
    } else if (!isOn()) {
      body = `
        <p class="text-[11px] text-slate-500 dark:text-slate-400">Keep this device and your others up to date through your own Google Drive. Everything is locked with a passphrase before it leaves the device, so Google can't read it.</p>
        <button type="button" onclick="AllInOneSync.turnOn()" class="${primary} w-full sm:w-auto"><span><svg class="ico" aria-hidden="true"><use href="#i-cloud"/></svg></span><span>Turn on sync</span></button>`;
    } else {
      const d = describe();
      const message = status.kind === 'error' && status.message ? `<p class="text-[11px] text-rose-600 dark:text-rose-400">${escapeText(status.message)}</p>` : '';
      body = `
        <div class="flex items-center space-x-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
          <span class="w-2 h-2 rounded-full shrink-0 ${d.dot}"></span><span>${escapeText(d.text)}</span>
        </div>
        ${message}
        <p class="text-[11px] text-slate-500 dark:text-slate-400">Syncs when the app opens, a couple of seconds after each change, and every minute while it's open. If the same record was changed on two devices, the newer change wins.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          ${status.kind === 'signin'
            ? `<button type="button" onclick="AllInOneSync.signIn()" class="${primary}"><span><svg class="ico" aria-hidden="true"><use href="#i-key"/></svg></span><span>Sign in to Google</span></button>`
            : `<button type="button" onclick="AllInOneSync.syncNow()" class="${primary}"><span><svg class="ico" aria-hidden="true"><use href="#i-refresh"/></svg></span><span>Sync now</span></button>`}
          <button type="button" onclick="AllInOneSync.turnOff()" class="${secondary}"><span><svg class="ico" aria-hidden="true"><use href="#i-player-pause"/></svg></span><span>Turn off on this device</span></button>
        </div>`;
    }
    card.innerHTML = `
      <div class="p-4 sm:p-5 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-slate-200 dark:border-slate-700/60 space-y-3">
        <h4 class="text-sm font-extrabold text-slate-800 dark:text-slate-100 flex items-center space-x-2">
          <span><svg class="ico" aria-hidden="true"><use href="#i-cloud"/></svg></span><span>Sync Between Devices</span>
        </h4>
        ${body}
      </div>`;
  }

  /* ---------- startup ---------- */
  function appReady() {
    appIsReady = true;
    const tab = ssGet(SS.returnTab);
    ssRemove(SS.returnTab);
    if (tab && typeof switchTab === 'function' && typeof currentTab !== 'undefined' && tab !== currentTab) {
      try { switchTab(tab); } catch (e) {}
    }
    const continueSetup = ssGet(SS.afterAuth) === 'setup';
    ssRemove(SS.afterAuth);
    if (isOn()) {
      hookApp();
      if (signInError) setStatus('signin');
      else syncNow();
    } else {
      renderStatus();
    }
    if (continueSetup) {
      if (window.AllInOne) AllInOne.openSettings('general');
      if (getToken()) turnOn();
      else alert('Google sign-in didn\'t finish' + (signInError ? ` (${signInError})` : '') + '. You can try again from Settings.');
    }
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !isOn()) return;
      if (status.kind === 'ok') renderStatus();
      syncNow();
    }, 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !isOn()) return;
      if (!getToken() && maybeSilentSignIn()) return;
      syncNow();
    });
    window.addEventListener('online', () => syncNow());
    window.addEventListener('offline', () => { if (isOn()) setStatus('offline'); });
  }

  captureSignInResult();
  // Renew Google access before the app draws, so opening the app is a quick bounce rather than a reload later
  maybeSilentSignIn();

  window.AllInOneSync = {
    isOn,
    isConfigured,
    turnOn,
    turnOff,
    syncNow,
    signIn: () => signIn(false),
    statusClicked,
    renderSettingsCard,
    appReady,
    setBusy,
    forgetLastSync
  };
})();
