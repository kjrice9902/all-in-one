/* ============================================================================
   ALL IN ONE — shared app code loaded by index.html:
   - JSON backup / restore of Medical records and documents
   - Weekly backup reminder
   - Settings panel tabs (General / Medical)
   Saved-data keys and database names are unchanged so existing data keeps working.
   ============================================================================ */
(function () {
  const MED_STATE_KEY = 'MediVault_Data_v1';
  const MED_DB = 'MediVault_Docs_DB';
  const MED_DB_VERSION = 2;

  const LAST_BACKUP_KEY = 'medivault_last_app_backup';
  const SNOOZE_KEY = 'allinone_backup_dismissed_until';
  const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

  /* ---------------------------- IndexedDB helpers ---------------------------- */
  function openDb(name, version, upgrade) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = (e) => upgrade(e.target.result);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }
  const openMedicalDb = () => openDb(MED_DB, MED_DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
  });

  function idbRequest(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      let result;
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  function localISODate(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function toast(msg, icon) {
    if (typeof window.showToast === 'function') window.showToast(msg, icon);
  }

  async function saveFile(content, filename, mime) {
    if (typeof window.promptSaveFile === 'function') return window.promptSaveFile(content, filename, mime);
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  // Record ids end up inside button code, so a restored backup may only use plain id characters
  const SAFE_ID = /^[A-Za-z0-9_.:\-]+$/;
  function findUnsafeId(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return null;
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'string' && (key === 'id' || /Id$/.test(key)) && v && !SAFE_ID.test(v)) return v;
      if (v && typeof v === 'object') {
        const bad = findUnsafeId(v, depth + 1);
        if (bad) return bad;
      }
    }
    return null;
  }

  /* ---------------------------------- Backup --------------------------------- */
  async function collectBackup() {
    // Flush unsaved changes so the backup has the latest records
    if (typeof window.saveState === 'function') {
      try { await window.saveState(); } catch (e) {}
    }

    let medicalState = null;
    try { medicalState = JSON.parse(localStorage.getItem(MED_STATE_KEY) || 'null'); } catch (e) {}

    let medicalDocs = [];
    const medDb = await openMedicalDb();
    if (medDb) {
      try { medicalDocs = (await idbRequest(medDb, 'documents', 'readonly', s => s.getAll())) || []; } catch (e) {}
      medDb.close();
    }

    return {
      app: 'All in One',
      format: 'all-in-one-backup',
      version: 3,
      exportedAt: new Date().toISOString(),
      medical: { state: medicalState, documents: medicalDocs }
    };
  }

  // The backup file is built one document at a time: turning everything into one giant string
  // runs out of memory once there are many large documents (especially on iPhone)
  function backupToBlob(backup) {
    const { documents, ...medicalRest } = backup.medical;
    const head = JSON.stringify({ ...backup, medical: { ...medicalRest, documents: [] } });
    if (!head.endsWith('[]}}')) return new Blob([JSON.stringify(backup)], { type: 'application/json' });
    const parts = [head.slice(0, -3)];
    (documents || []).forEach((d, i) => parts.push((i ? ',' : '') + JSON.stringify(d)));
    parts.push(']}}');
    return new Blob(parts, { type: 'application/json' });
  }

  // Mac app: its local server saves the backup straight into the Desktop's All in One folder.
  // Resolves to the saved file's name, or null anywhere else (then the normal save dialog is used).
  async function saveBackupToAppFolder(blob, fileName) {
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return null;
    try {
      const res = await fetch('/__backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-All-In-One': 'backup', 'X-File-Name': fileName },
        body: blob
      });
      if (!res.ok) return null;
      return (await res.json()).name || fileName;
    } catch (e) {
      return null;
    }
  }

  async function exportBackup() {
    try {
      const backup = await collectBackup();
      const blob = backupToBlob(backup);
      const fileName = `All_in_One_Backup_${localISODate()}.json`;
      const toFolder = await saveBackupToAppFolder(blob, fileName);
      if (toFolder) {
        markBackupDone();
        toast(`Backup saved to Desktop › All in One as ${toFolder}`, '💾');
        return true;
      }
      const saved = await saveFile(blob, fileName, 'application/json');
      if (saved) {
        markBackupDone();
        toast('Backup saved — all Medical records and documents are included.', '💾');
      } else {
        toast('Backup export cancelled.', 'ℹ️');
      }
      return Boolean(saved);
    } catch (e) {
      console.error('Backup failed:', e);
      toast('Backup failed: ' + (e && e.message ? e.message : e), '⚠️');
      return false;
    }
  }

  // Accepts current backups and older Medical-only ones; any Storage section in an old backup is ignored
  function parseBackup(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.format === 'all-in-one-backup') {
      return data.medical && data.medical.state ? { medical: data.medical } : null;
    }
    if (data.state && typeof data.state === 'object') {
      return { medical: { state: data.state, documents: data.documents || [] } };
    }
    return null;
  }

  /* ------------------------- Restoring very large backups ------------------------- */
  // Reading a whole backup into memory and parsing it at once fails for very large files (around
  // 500 MB on iPhone). Above this size the file is read in pieces and documents are restored one batch at a time.
  const STREAM_RESTORE_BYTES = 100 * 1024 * 1024;
  const RESTORE_BATCH_BYTES = 32 * 1024 * 1024;

  // Number of backslashes just before `end` (stopping at `start`); `carry` continues a run from the previous piece
  function backslashesBefore(text, end, start, carry) {
    let k = end - 1, n = 0;
    while (k >= start && text.charCodeAt(k) === 92) { n++; k--; }
    return k < start ? n + carry : n;
  }

  // Reads a backup file 8 MB at a time. Each entry of its "documents" list is parsed on its own and handed
  // to onDoc (awaited); everything else comes back as JSON text with an empty documents list.
  async function scanBackupFile(file, onDoc) {
    const CHUNK = 8 * 1024 * 1024;
    const decoder = new TextDecoder();
    const header = [];
    const stack = [];
    const keyAt = [];
    let inString = false, strParts = null, carry = 0, pendingKey = null;
    let docsDepth = 0, docsDone = false, elParts = null;
    for (let pos = 0; ; pos += CHUNK) {
      const last = pos + CHUNK >= file.size;
      const t = decoder.decode(await file.slice(pos, pos + CHUNK).arrayBuffer(), { stream: !last });
      let hdrFrom = docsDepth ? -1 : 0;
      let elFrom = elParts ? 0 : -1;
      let strFrom = strParts ? 0 : -1;
      let i = 0;
      while (i < t.length) {
        if (inString) {
          const j = t.indexOf('"', i);
          if (j < 0) { carry = backslashesBefore(t, t.length, i, carry); break; }
          const run = backslashesBefore(t, j, i, carry);
          carry = 0;
          if (run % 2 === 1) { i = j + 1; continue; }
          inString = false;
          if (strParts) { strParts.push(t.slice(strFrom, j)); pendingKey = strParts.join(''); strParts = null; strFrom = -1; }
          else pendingKey = null;
          i = j + 1;
          continue;
        }
        const c = t[i];
        if (c === '"') {
          inString = true;
          carry = 0;
          // Only names near the top are needed, to find the "documents" list; document contents are skipped over
          if (!docsDepth && stack.length <= 3) { strParts = []; strFrom = i + 1; }
        } else if (c === ':') {
          if (pendingKey !== null && stack[stack.length - 1] === '{') keyAt[stack.length] = pendingKey;
          pendingKey = null;
        } else if (c === '{' || c === '[') {
          pendingKey = null;
          if (c === '[' && !docsDepth && !docsDone && stack.length <= 2 && stack[stack.length - 1] === '{' && keyAt[stack.length] === 'documents') {
            stack.push('[');
            docsDepth = stack.length;
            header.push(t.slice(hdrFrom, i + 1));
            hdrFrom = -1;
            i++;
            continue;
          }
          if (docsDepth && stack.length === docsDepth && c === '{') { elParts = []; elFrom = i; }
          stack.push(c);
          keyAt[stack.length] = undefined;
        } else if (c === '}' || c === ']') {
          pendingKey = null;
          stack.pop();
          if (docsDepth && elParts && stack.length === docsDepth) {
            elParts.push(t.slice(elFrom, i + 1));
            const text = elParts.join('');
            elParts = null;
            elFrom = -1;
            await onDoc(JSON.parse(text));
          } else if (docsDepth && stack.length === docsDepth - 1) {
            docsDepth = 0;
            docsDone = true;
            hdrFrom = i;
          }
        } else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') {
          pendingKey = null;
        }
        i++;
      }
      if (hdrFrom >= 0) header.push(t.slice(hdrFrom));
      if (elParts && elFrom >= 0) elParts.push(t.slice(elFrom));
      if (strParts && strFrom >= 0) strParts.push(t.slice(strFrom));
      if (last) break;
    }
    if (stack.length || inString) throw new Error('The backup file is incomplete or damaged');
    return header.join('');
  }

  async function importLargeBackup(file) {
    let medicalWritten = false;
    try {
      toast('Checking the backup file…', '⏳');
      // First read: check everything before changing anything
      let docCount = 0, badId = null;
      const headerText = await scanBackupFile(file, doc => {
        if (!doc || typeof doc !== 'object') return;
        docCount++;
        if (!badId) badId = findUnsafeId(doc, 2);
      });
      const parsed = parseBackup(JSON.parse(headerText));
      if (!parsed) {
        alert('This file has no Medical records to restore. It may not be an All in One backup.');
        return;
      }
      if (badId || findUnsafeId(parsed.medical)) {
        alert('This backup contains invalid record IDs and can\'t be restored safely. It may have been edited or damaged.');
        return;
      }
      if (navigator.storage && navigator.storage.estimate) {
        const { quota } = await navigator.storage.estimate();
        if (quota && file.size > quota * 0.9) {
          alert(`This backup (${Math.round(file.size / 1048576)} MB) is larger than the space this browser allows the app (${Math.round(quota / 1048576)} MB), so it can't be restored here. Nothing was changed.`);
          return;
        }
      }
      const syncNote = window.AllInOneSync && AllInOneSync.isOn() ? '• Sync is on, so your other devices will be replaced too\n' : '';
      if (!confirm(`Restore this backup?\n\n• Medical records and ${docCount} documents will be REPLACED\n` + syncNote + '\nThis is a large backup, so it can take a few minutes. Keep the app open until it finishes.\nThe app will reload when finished.')) return;

      const medDb = await openMedicalDb();
      if (!medDb) throw new Error('Could not open the medical document database');
      // Records first: if they don't fit, nothing has changed yet
      // No sync pass may touch records or documents from here until the reload; and a restore made while
      // sync is off means this device joins afresh when sync is turned on again
      if (window.AllInOneSync) {
        AllInOneSync.setBusy(true);
        if (!AllInOneSync.isOn()) AllInOneSync.forgetLastSync();
      }
      const previousState = localStorage.getItem(MED_STATE_KEY);
      try {
        localStorage.setItem(MED_STATE_KEY, JSON.stringify(parsed.medical.state));
      } catch (err) {
        medDb.close();
        throw err;
      }
      medicalWritten = true;
      try {
        await idbRequest(medDb, 'documents', 'readwrite', st => { st.clear(); });
      } catch (err) {
        try {
          if (previousState === null) localStorage.removeItem(MED_STATE_KEY);
          else localStorage.setItem(MED_STATE_KEY, previousState);
        } catch (e) {}
        medDb.close();
        throw err;
      }

      // Second read: save documents a batch at a time (a database transaction can't stay open while the file is read)
      let batch = [], batchBytes = 0, saved = 0;
      const flush = async () => {
        if (!batch.length) return;
        const docs = batch;
        batch = [];
        batchBytes = 0;
        await idbRequest(medDb, 'documents', 'readwrite', st => { docs.forEach(d => st.put(d)); });
        saved += docs.length;
        toast(`Restoring documents… ${saved} of ${docCount}`, '⏳');
      };
      try {
        await scanBackupFile(file, async doc => {
          if (!doc || typeof doc !== 'object' || !doc.id) return;
          batch.push(doc);
          batchBytes += (doc.dataUrl || '').length;
          if (batchBytes >= RESTORE_BATCH_BYTES || batch.length >= 50) await flush();
        });
        await flush();
      } catch (err) {
        console.error('Restore stopped partway:', err);
        alert(`Your records were restored, but only ${saved} of ${docCount} documents were saved before this stopped (${err && err.message ? err.message : err}). Free up space on this device and restore the same file again.`);
        location.reload();
        return;
      } finally {
        medDb.close();
      }
      alert('Backup restored. The app will now reload.');
      location.reload();
    } catch (e) {
      console.error('Restore failed:', e);
      alert('Could not restore this backup: ' + (e && e.message ? e.message : e));
      if (medicalWritten) location.reload();
      else if (window.AllInOneSync) AllInOneSync.setBusy(false);
    }
  }

  async function importBackup(event) {
    const input = event && event.target;
    const file = input && input.files && input.files[0];
    if (!file) return;
    if (file.size > STREAM_RESTORE_BYTES) {
      try {
        await importLargeBackup(file);
      } finally {
        if (input) input.value = '';
      }
      return;
    }
    let medicalWritten = false;
    try {
      const parsed = parseBackup(JSON.parse(await file.text()));
      if (!parsed) {
        alert('This file has no Medical records to restore. It may not be an All in One backup.');
        return;
      }
      const unsafeId = findUnsafeId(parsed.medical);
      if (unsafeId) {
        alert('This backup contains invalid record IDs and can\'t be restored safely. It may have been edited or damaged.');
        return;
      }
      const syncNote = window.AllInOneSync && AllInOneSync.isOn() ? '• Sync is on, so your other devices will be replaced too\n' : '';
      if (!confirm('Restore this backup?\n\n• Medical records and documents will be REPLACED\n' + syncNote + '\nThe app will reload when finished.')) return;

      const docs = Array.isArray(parsed.medical.documents) ? parsed.medical.documents : [];
      const medDb = await openMedicalDb();
      if (!medDb) throw new Error('Could not open the medical document database');
      // Records first: if they don't fit, nothing has changed yet. Documents are replaced in one
      // transaction, so if that fails the old documents stay and the old records are put back with them.
      // No sync pass may touch records or documents from here until the reload; and a restore made while
      // sync is off means this device joins afresh when sync is turned on again
      if (window.AllInOneSync) {
        AllInOneSync.setBusy(true);
        if (!AllInOneSync.isOn()) AllInOneSync.forgetLastSync();
      }
      const previousState = localStorage.getItem(MED_STATE_KEY);
      try {
        localStorage.setItem(MED_STATE_KEY, JSON.stringify(parsed.medical.state));
      } catch (err) {
        medDb.close();
        throw err;
      }
      medicalWritten = true;
      try {
        await idbRequest(medDb, 'documents', 'readwrite', s => {
          s.clear();
          docs.forEach(d => d && d.id && s.put(d));
        });
      } catch (err) {
        try {
          if (previousState === null) localStorage.removeItem(MED_STATE_KEY);
          else localStorage.setItem(MED_STATE_KEY, previousState);
        } catch (e) {}
        throw err;
      } finally {
        medDb.close();
      }

      alert('Backup restored. The app will now reload.');
      location.reload();
    } catch (e) {
      console.error('Restore failed:', e);
      alert('Could not restore this backup: ' + (e && e.message ? e.message : e));
      // The page still holds the pre-restore state in memory; without a reload its next save would overwrite the restored records
      if (medicalWritten) location.reload();
      else if (window.AllInOneSync) AllInOneSync.setBusy(false);
    } finally {
      if (input) input.value = '';
    }
  }

  /* ---------------------------- Backup reminder ------------------------------ */
  function reminderBanner() {
    return document.getElementById('biweeklyBackupReminderBanner') || document.getElementById('monthlyBackupReminderBanner');
  }

  function checkBackupReminder() {
    const banner = reminderBanner();
    if (!banner) return;
    const now = Date.now();
    const last = parseInt(localStorage.getItem(LAST_BACKUP_KEY) || '0', 10);
    // A snooze set back when the reminder was every 2 weeks never lasts longer than a week
    const snoozedUntil = Math.min(parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10), now + BACKUP_INTERVAL_MS);
    const show = now >= snoozedUntil && !(last > 0 && now - last < BACKUP_INTERVAL_MS);
    banner.classList.toggle('hidden', !show);
  }

  function dismissBackupReminder() {
    const banner = reminderBanner();
    if (banner) banner.classList.add('hidden');
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + BACKUP_INTERVAL_MS));
    toast('Reminder snoozed for 1 week.', '⏳');
  }

  function markBackupDone() {
    const banner = reminderBanner();
    if (banner) banner.classList.add('hidden');
    localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
    localStorage.removeItem(SNOOZE_KEY);
  }

  /* ------------------------------ Settings panel ----------------------------- */
  const TABS = [
    { id: 'general', label: 'General' },
    { id: 'medical', label: 'Medical' }
  ];

  function renderSettingsTabs() {
    const bar = document.getElementById('aioSettingsTabBar');
    if (!bar) return;
    bar.innerHTML = TABS.map(t => `
      <button type="button" data-aio-tab="${t.id}" onclick="AllInOne.showSettingsTab('${t.id}')"
        class="flex-1 px-3 py-2 rounded-xl text-xs font-extrabold transition border border-transparent">
        ${t.label}
      </button>`).join('');
    showSettingsTab('general');
  }

  function showSettingsTab(tabId) {
    document.querySelectorAll('[data-aio-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.aioPane !== tabId));
    document.querySelectorAll('#aioSettingsTabBar [data-aio-tab]').forEach(b => {
      const active = b.dataset.aioTab === tabId;
      b.classList.toggle('bg-indigo-600', active);
      b.classList.toggle('text-white', active);
      b.classList.toggle('shadow-sm', active);
      b.classList.toggle('bg-slate-100', !active);
      b.classList.toggle('dark:bg-slate-800', !active);
      b.classList.toggle('text-slate-600', !active);
      b.classList.toggle('dark:text-slate-300', !active);
    });
  }

  function renderGeneralPane() {
    const pane = document.getElementById('aioGeneralPane');
    if (!pane) return;
    pane.innerHTML = GENERAL_DISPLAY_THEME_HTML + `
      <div id="syncSettingsCard"></div>
      <div class="p-4 sm:p-5 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-slate-200 dark:border-slate-700/60 space-y-3">
        <div>
          <h4 class="text-sm font-extrabold text-slate-800 dark:text-slate-100 flex items-center space-x-2">
            <span><svg class="ico" aria-hidden="true"><use href="#i-device-floppy"/></svg></span><span>Backup &amp; Restore</span>
          </h4>
          <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1">One JSON file holds all your Medical records and uploaded documents. Restoring it replaces what's in the app.</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <button type="button" onclick="AllInOne.exportBackup()" class="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-extrabold shadow-sm transition flex items-center justify-center space-x-2">
            <span><svg class="ico" aria-hidden="true"><use href="#i-download"/></svg></span><span>Export JSON Backup</span>
          </button>
          <label class="px-4 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-400 text-slate-700 dark:text-slate-200 text-xs font-extrabold transition flex items-center justify-center space-x-2 cursor-pointer">
            <span><svg class="ico" aria-hidden="true"><use href="#i-folder-open"/></svg></span><span>Restore from JSON Backup</span>
            <input type="file" accept=".json,application/json" class="hidden" onchange="AllInOne.importBackup(event)">
          </label>
        </div>
      </div>`;
    if (window.AllInOneSync) AllInOneSync.renderSettingsCard();
  }

  function openSettings(tabId = 'general') {
    if (typeof window.openSettingsModal === 'function') window.openSettingsModal();
    showSettingsTab(tabId);
  }

  function initSettingsPanel() {
    renderSettingsTabs();
    renderGeneralPane();
  }

  window.addEventListener('load', checkBackupReminder);

  // Hosted (https) copy only: work offline and ask the browser not to clear saved records.
  // The Mac app runs on plain http://localhost and keeps loading files straight from disk.
  if (location.protocol === 'https:') {
    window.addEventListener('load', () => {
      if ('serviceWorker' in navigator) {
        const hadWorker = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.register('sw.js').then((reg) => {
          // iPhone home-screen apps usually resume instead of reloading, so check for an update on every return
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reg.update().catch(() => {});
          });
        }).catch(err => console.warn('Offline support unavailable:', err));
        // A new version took over: reload once to show it, but never while a window (maybe with typing) is open
        let reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadWorker || reloading) return;
          reloading = true;
          const reloadWhenIdle = () => {
            const busy = document.querySelector('[id$="Modal"]:not(.hidden), [data-aio-sync-overlay]');
            if (busy) setTimeout(reloadWhenIdle, 2000);
            else location.reload();
          };
          reloadWhenIdle();
        });
      }
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
    });
  }

  window.AllInOne = {
    exportBackup,
    importBackup,
    checkBackupReminder,
    dismissBackupReminder,
    markBackupDone,
    initSettingsPanel,
    showSettingsTab,
    openSettings
  };

  const GENERAL_DISPLAY_THEME_HTML = "        <!-- =====================================================================\n             DISPLAY & ACCESSIBILITY: INTERFACE ZOOM & TEXT SIZE (SHARED ACROSS APP)\n             ===================================================================== -->\n        <div class=\"p-4 bg-slate-50 dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700/80 space-y-4\">\n          <div class=\"flex items-center justify-between border-b border-slate-200/70 dark:border-slate-700/60 pb-2\">\n            <div>\n              <h4 class=\"font-bold text-slate-800 dark:text-slate-100 flex items-center space-x-1.5 text-xs sm:text-sm\">\n                <span><svg class=\"ico\" aria-hidden=\"true\"><use href=\"#i-search\"/></svg></span>\n                <span>Display & Accessibility (Universal Scaling)</span>\n              </h4>\n              <p class=\"text-[11px] text-slate-500 dark:text-slate-400 mt-0.5\">Scale the whole interface and text size.</p>\n            </div>\n          </div>\n\n          <!-- Feature 1: Interface Zoom (Zoom In / Out) -->\n          <div class=\"space-y-2\">\n            <div class=\"flex items-center justify-between\">\n              <div>\n                <label class=\"text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center space-x-1\">\n                  <span><svg class=\"ico\" aria-hidden=\"true\"><use href=\"#i-device-desktop\"/></svg></span>\n                  <span>Interface Zoom</span>\n                </label>\n                <p class=\"text-[10px] text-slate-400\">Scale all windows, panels, and buttons larger or smaller</p>\n              </div>\n              <span id=\"appZoomBadge\" class=\"text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800\">\n                100%\n              </span>\n            </div>\n            \n            <div class=\"flex items-center space-x-2 pt-1\">\n              <button type=\"button\" onclick=\"adjustAppZoom(-10)\" title=\"Zoom Out (Cmd/Ctrl + Minus)\" class=\"flex-1 py-2 px-2 whitespace-nowrap rounded-xl bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold text-xs flex items-center justify-center space-x-1 shadow-sm transition\">\n                <span>\u2212</span>\n                <span>Zoom Out</span>\n              </button>\n              <button type=\"button\" onclick=\"resetAppZoom()\" title=\"Reset to 100% (Cmd/Ctrl + 0)\" class=\"py-2 px-2.5 whitespace-nowrap rounded-xl bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold text-xs transition\">\n                Reset\n              </button>\n              <button type=\"button\" onclick=\"adjustAppZoom(10)\" title=\"Zoom In (Cmd/Ctrl + Plus)\" class=\"flex-1 py-2 px-2 whitespace-nowrap rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center justify-center space-x-1 shadow-sm transition\">\n                <span>+</span>\n                <span>Zoom In</span>\n              </button>\n            </div>\n\n            <!-- Quick Presets -->\n            <div class=\"flex items-center flex-wrap gap-1.5 pt-1 text-[10px]\">\n              <span class=\"text-slate-400 font-medium mr-1\">Presets:</span>\n              <button type=\"button\" onclick=\"setAppZoom(90)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition\">90%</button>\n              <button type=\"button\" onclick=\"setAppZoom(100)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition font-bold\">100%</button>\n              <button type=\"button\" onclick=\"setAppZoom(110)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition\">110%</button>\n              <button type=\"button\" onclick=\"setAppZoom(125)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition\">125%</button>\n              <button type=\"button\" onclick=\"setAppZoom(140)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition\">140%</button>\n              <button type=\"button\" onclick=\"setAppZoom(160)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition\">160%</button>\n            </div>\n          </div>\n\n          <!-- Feature 2: Text / Font Size (Increase / Decrease) -->\n          <div class=\"space-y-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/50\">\n            <div class=\"flex items-center justify-between\">\n              <div>\n                <label class=\"text-xs font-bold text-slate-700 dark:text-slate-200 flex items-center space-x-1\">\n                  <span><svg class=\"ico\" aria-hidden=\"true\"><use href=\"#i-typography\"/></svg></span>\n                  <span>Text Size</span>\n                </label>\n                <p class=\"text-[10px] text-slate-400\">Increase or decrease text readability across all records and vault documents</p>\n              </div>\n              <span id=\"appTextSizeBadge\" class=\"text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-teal-100 dark:bg-teal-950/80 text-teal-800 dark:text-teal-300 border border-teal-200 dark:border-teal-800\">\n                Normal (16px)\n              </span>\n            </div>\n\n            <div class=\"flex items-center space-x-2 pt-1\">\n              <button type=\"button\" onclick=\"adjustAppTextSize(-1)\" title=\"Decrease Text Size\" class=\"flex-1 py-2 px-2 whitespace-nowrap rounded-xl bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold text-xs flex items-center justify-center space-x-1 shadow-sm transition\">\n                <span class=\"text-sm font-extrabold\">A\u2212</span>\n                <span>Smaller</span>\n              </button>\n              <button type=\"button\" onclick=\"resetAppTextSize()\" title=\"Reset to Normal (16px)\" class=\"py-2 px-2.5 whitespace-nowrap rounded-xl bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold text-xs transition\">\n                Reset\n              </button>\n              <button type=\"button\" onclick=\"adjustAppTextSize(1)\" title=\"Increase Text Size\" class=\"flex-1 py-2 px-2 whitespace-nowrap rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs flex items-center justify-center space-x-1 shadow-sm transition\">\n                <span class=\"text-sm font-extrabold\">A+</span>\n                <span>Larger</span>\n              </button>\n            </div>\n\n            <!-- Quick Text Size Presets -->\n            <div class=\"flex items-center flex-wrap gap-1.5 pt-1 text-[10px]\">\n              <span class=\"text-slate-400 font-medium mr-1\">Presets:</span>\n              <button type=\"button\" onclick=\"setAppTextSize(14)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-teal-100 dark:hover:bg-teal-900 transition\">Small (14px)</button>\n              <button type=\"button\" onclick=\"setAppTextSize(16)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-teal-100 dark:hover:bg-teal-900 transition font-bold\">Normal (16px)</button>\n              <button type=\"button\" onclick=\"setAppTextSize(18)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-teal-100 dark:hover:bg-teal-900 transition\">Large (18px)</button>\n              <button type=\"button\" onclick=\"setAppTextSize(20)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-teal-100 dark:hover:bg-teal-900 transition\">Extra Large (20px)</button>\n              <button type=\"button\" onclick=\"setAppTextSize(22)\" class=\"px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-teal-100 dark:hover:bg-teal-900 transition\">Huge (22px)</button>\n            </div>\n          </div>\n        </div>\n\n        \n        \n        <!-- =====================================================================\n             CHANGE THEME & COLOR PALETTE (SHARED ACROSS APP)\n             ===================================================================== -->\n        <div class=\"p-4 bg-slate-50 dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700/80 space-y-3\">\n          <div class=\"flex items-center justify-between border-b border-slate-200/70 dark:border-slate-700/60 pb-2\">\n            <div>\n              <h4 class=\"font-bold text-slate-800 dark:text-slate-100 flex items-center space-x-1.5 text-xs sm:text-sm\">\n                <span><svg class=\"ico\" aria-hidden=\"true\"><use href=\"#i-palette\"/></svg></span>\n                <span>Change Theme & Color Palette</span>\n              </h4>\n              <p class=\"text-[11px] text-slate-500 dark:text-slate-400 mt-0.5\">Choose your favorite look.</p>\n            </div>\n            <span id=\"activeThemeBadge\" class=\"text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-slate-600 capitalize\">\n              Slate\n            </span>\n          </div>\n\n          <!-- Color Theme Selection Grid -->\n          <div class=\"grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 text-xs\" id=\"themePickerGrid\">\n            <!-- 1. Monochrome (Black, White & Gray) -->\n            <button type=\"button\" onclick=\"setAppColorTheme('monochrome')\" data-theme-btn=\"monochrome\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0 border border-zinc-500\" style=\"background: linear-gradient(135deg, #09090b 50%, #f4f4f5 50%);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Monochrome</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Black, White & Gray</div>\n              </div>\n            </button>\n\n            <!-- 2. Midnight Slate (Default) -->\n            <button type=\"button\" onclick=\"setAppColorTheme('slate')\" data-theme-btn=\"slate\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #4f46e5, #9333ea, #e11d48);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Midnight Slate</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Indigo, Violet & Rose</div>\n              </div>\n            </button>\n\n            <!-- 3. Emerald Sanctuary -->\n            <button type=\"button\" onclick=\"setAppColorTheme('emerald')\" data-theme-btn=\"emerald\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #059669, #0d9488, #10b981);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Emerald</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Forest & Mint Green</div>\n              </div>\n            </button>\n\n            <!-- 4. Ocean Pacific -->\n            <button type=\"button\" onclick=\"setAppColorTheme('ocean')\" data-theme-btn=\"ocean\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #0284c7, #2563eb, #06b6d4);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Ocean Pacific</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Cobalt, Azure & Cyan</div>\n              </div>\n            </button>\n\n            <!-- 5. Royal Amethyst -->\n            <button type=\"button\" onclick=\"setAppColorTheme('amethyst')\" data-theme-btn=\"amethyst\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #7c3aed, #9333ea, #c026d3);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Royal Amethyst</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Deep Violet & Purple</div>\n              </div>\n            </button>\n\n            <!-- 6. Sunset Amber -->\n            <button type=\"button\" onclick=\"setAppColorTheme('amber')\" data-theme-btn=\"amber\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #d97706, #ea580c, #f59e0b);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Sunset Amber</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Warm Copper & Gold</div>\n              </div>\n            </button>\n\n            <!-- 7. Ruby Crimson -->\n            <button type=\"button\" onclick=\"setAppColorTheme('crimson')\" data-theme-btn=\"crimson\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #e11d48, #f43f5e, #be123c);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Ruby Crimson</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Scarlet & Rose</div>\n              </div>\n            </button>\n\n            <!-- 8. Rose Blush -->\n            <button type=\"button\" onclick=\"setAppColorTheme('rose')\" data-theme-btn=\"rose\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #be185d, #db2777, #f472b6);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Rose Blush</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Pink & Blush</div>\n              </div>\n            </button>\n\n            <!-- 9. Teal Lagoon -->\n            <button type=\"button\" onclick=\"setAppColorTheme('teal')\" data-theme-btn=\"teal\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #0f766e, #0d9488, #2dd4bf);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Teal Lagoon</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Teal & Seafoam</div>\n              </div>\n            </button>\n\n            <!-- 10. Lavender Haze -->\n            <button type=\"button\" onclick=\"setAppColorTheme('lavender')\" data-theme-btn=\"lavender\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #5b51ad, #6c63c7, #a8a2ec);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Lavender Haze</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Lilac & Periwinkle</div>\n              </div>\n            </button>\n\n            <!-- 11. Coral Reef -->\n            <button type=\"button\" onclick=\"setAppColorTheme('coral')\" data-theme-btn=\"coral\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #b43c1c, #c94a2a, #fb9a7a);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Coral Reef</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Peach & Coral</div>\n              </div>\n            </button>\n\n            <!-- 12. Sage Garden -->\n            <button type=\"button\" onclick=\"setAppColorTheme('sage')\" data-theme-btn=\"sage\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #4a6040, #5a7550, #93ad82);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Sage Garden</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Olive & Sage Green</div>\n              </div>\n            </button>\n\n            <!-- 13. Mocha Coffee -->\n            <button type=\"button\" onclick=\"setAppColorTheme('mocha')\" data-theme-btn=\"mocha\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #7a5137, #8f5e3a, #c99a72);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Mocha Coffee</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Espresso & Caramel</div>\n              </div>\n            </button>\n\n            <!-- 14. Nordic Frost -->\n            <button type=\"button\" onclick=\"setAppColorTheme('nord')\" data-theme-btn=\"nord\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #465a7a, #52759f, #88c0d0);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Nordic Frost</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Cool Blue-Gray</div>\n              </div>\n            </button>\n\n            <!-- 15. Onyx & Gold -->\n            <button type=\"button\" onclick=\"setAppColorTheme('gold')\" data-theme-btn=\"gold\" class=\"p-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500 text-left transition flex items-center space-x-2.5 cursor-pointer shadow-2xs\">\n              <span class=\"w-6 h-6 rounded-lg shrink-0\" style=\"background: linear-gradient(135deg, #0a0a0a 50%, #d4a017 50%);\"></span>\n              <div class=\"min-w-0\">\n                <div class=\"font-bold text-slate-800 dark:text-slate-200 leading-tight\">Onyx & Gold</div>\n                <div class=\"text-[10px] text-slate-400 truncate\">Black & Gold</div>\n              </div>\n            </button>\n          </div>\n        </div>\n\n";
})();
