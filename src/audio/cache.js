// rap-mv/src/audio/cache.js — 把使用者上傳的音檔存在「這台裝置」的 IndexedDB，
// 這樣重載頁面不用重新選一次 11MB 的檔案。
//
// 重要：**只存在本機瀏覽器，不上傳任何地方**（專案 repo 是公開的，音檔不進版控）。
// 任何失敗（Safari 無痕、容量不足、舊瀏覽器）都必須安靜降級成「沒有快取」，
// 不能讓它擋住工作室啟動。
const DB_NAME = 'rap-mv-audio';
const STORE = 'files';
const KEY = 'current';
const DB_VERSION = 1;

function factory() {
  try {
    return typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined;
  } catch {
    return undefined;
  }
}

export function isSupported() {
  return !!factory();
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 操作失敗'));
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const idb = factory();
    if (!idb) {
      reject(new Error('這個瀏覽器不支援 IndexedDB'));
      return;
    }
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 開啟失敗'));
    req.onblocked = () => reject(new Error('IndexedDB 被其他分頁鎖住'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 交易失敗'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 交易被中止'));
  });
}

const closeQuietly = (db) => {
  try { db.close(); } catch { /* ignore */ }
};

export async function saveAudio(file) {
  if (!file) return { ok: false, reason: 'no-file' };
  let db = null;
  try {
    db = await openDb();
    const record = {
      name: file.name || 'audio',
      type: file.type || '',
      size: typeof file.size === 'number' ? file.size : 0,
      blob: file,
      savedAt: Date.now(),
    };
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record, KEY);
    await txDone(tx);
    return { ok: true, size: record.size };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    if (db) closeQuietly(db);
  }
}

export async function loadAudio() {
  let db = null;
  try {
    db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const record = await requestToPromise(tx.objectStore(STORE).get(KEY));
    if (!record || !record.blob) return null;
    // 還原成 File，讓上層流程（file.name / arrayBuffer）完全不用改
    let file = record.blob;
    if (typeof File === 'function' && typeof record.blob.arrayBuffer === 'function') {
      try {
        file = new File([record.blob], record.name || 'audio', { type: record.type || record.blob.type || '' });
      } catch { /* 少數環境不能建 File，退回 Blob（上層仍可解碼） */ }
    }
    return {
      file,
      name: record.name || (file.name || 'audio'),
      size: record.size || 0,
      savedAt: record.savedAt || 0,
    };
  } catch {
    return null;
  } finally {
    if (db) closeQuietly(db);
  }
}

export async function hasAudio() {
  const found = await loadAudio();
  return !!found;
}

export async function clearAudio() {
  let db = null;
  try {
    db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    await txDone(tx);
    return true;
  } catch {
    return false;
  } finally {
    if (db) closeQuietly(db);
  }
}
