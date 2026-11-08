// rap-mv/test/audio-cache.test.mjs — src/audio/cache.js（本機音檔快取）的單元測試
//
// 用一個極簡的 in-memory IndexedDB 替身（Node 沒有 indexedDB），驗證：
//  ① 存進去的歌可以原樣讀回來（重載頁面自動載入靠這個）
//  ② 沒有快取時回 null，不會抛錯
//  ③ 「重設」會清掉快取
//  ④ 環境不支援 / 容量爆掉時必須安靜降級（不能擋住工作室啟動）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveAudio, loadAudio, clearAudio, hasAudio, isSupported } from '../src/audio/cache.js';

const STORE = 'files';
const KEY = 'current';

// ── 極簡 fake IndexedDB ───────────────────────────────────────
function makeFakeIndexedDB(options = {}) {
  const data = new Map();
  const state = { writes: 0, openMode: null };

  function makeRequest(result) {
    return { result };
  }

  function makeTransaction() {
    const ops = [];
    const store = {
      get(key) {
        const req = makeRequest(undefined);
        ops.push(() => {
          req.result = data.get(key);
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
      put(value, key) {
        const req = makeRequest(undefined);
        ops.push(() => {
          if (options.failWrites) {
            req.error = new Error('QuotaExceededError');
            req.onerror && req.onerror();
            return;
          }
          state.writes += 1;
          data.set(key, value);
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
      delete(key) {
        const req = makeRequest(undefined);
        ops.push(() => {
          data.delete(key);
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
    };
    const tx = { objectStore: () => store, error: null };
    setTimeout(() => {
      for (const op of ops) op();
      if (options.failWrites) {
        tx.error = new Error('QuotaExceededError');
        tx.onerror && tx.onerror();
      } else {
        tx.oncomplete && tx.oncomplete();
      }
    }, 0);
    return tx;
  }

  const db = {
    objectStoreNames: { contains: (name) => name === STORE },
    createObjectStore() {},
    transaction: () => makeTransaction(),
    close() {},
  };

  return {
    open() {
      const req = makeRequest(undefined);
      setTimeout(() => {
        req.result = db;
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
    __data: data,
    __state: state,
  };
}

function setFake(fake) {
  globalThis.indexedDB = fake;
}

function makeFile(text, name = 'Night Shift.wav', type = 'audio/wav') {
  const bytes = new TextEncoder().encode(text);
  return new File([bytes], name, { type });
}

// ── 測試 ─────────────────────────────────────────────────────
test('audio cache：存進去再讀出來，檔名／大小／內容都一致', async () => {
  setFake(makeFakeIndexedDB());
  const file = makeFile('RIFF....fake-wav-content', 'Night Shift.wav', 'audio/wav');

  const saved = await saveAudio(file);
  assert.equal(saved.ok, true, `存檔應成功，實際 ${JSON.stringify(saved)}`);

  const loaded = await loadAudio();
  assert.ok(loaded, '應該讀得回快取');
  assert.equal(loaded.name, 'Night Shift.wav');
  assert.equal(loaded.size, file.size);
  assert.ok(loaded.file, '應還原成可用的 File/Blob');
  const text = new TextDecoder().decode(await loaded.file.arrayBuffer());
  assert.equal(text, 'RIFF....fake-wav-content', '音檔內容必須一字不差');
});

test('audio cache：沒有快取時回 null、hasAudio=false', async () => {
  setFake(makeFakeIndexedDB());
  assert.equal(await loadAudio(), null);
  assert.equal(await hasAudio(), false);
});

test('audio cache：clearAudio 之後就讀不到（重設會用到）', async () => {
  setFake(makeFakeIndexedDB());
  await saveAudio(makeFile('abc'));
  assert.equal(await hasAudio(), true);

  assert.equal(await clearAudio(), true);
  assert.equal(await loadAudio(), null);
  assert.equal(await hasAudio(), false);
  assert.equal(await clearAudio(), true, '重複清除不該抛錯');
});

test('audio cache：重複存檔會覆蓋（換歌只留最新的）', async () => {
  const fake = makeFakeIndexedDB();
  setFake(fake);
  await saveAudio(makeFile('第一首', 'song-a.wav'));
  await saveAudio(makeFile('第二首', 'song-b.wav'));

  const loaded = await loadAudio();
  assert.equal(loaded.name, 'song-b.wav');
  assert.equal(fake.__data.size, 1, `只該留一筆，實際 ${fake.__data.size}`);
  assert.equal(new TextDecoder().decode(await loaded.file.arrayBuffer()), '第二首');
});

test('audio cache：環境不支援時安靜降級（不抛錯、回 false/null）', async () => {
  delete globalThis.indexedDB;
  assert.equal(isSupported(), false);
  const res = await saveAudio(makeFile('x'));
  assert.equal(res.ok, false);
  assert.equal(await loadAudio(), null);
  assert.equal(await clearAudio(), false, '沒有 IndexedDB 時清除回 false');
});

test('audio cache：容量爆掉時回 ok:false，但不會讓程式炸掉', async () => {
  setFake(makeFakeIndexedDB({ failWrites: true }));
  let res;
  try {
    res = await saveAudio(makeFile('太大'));
  } catch (err) {
    assert.fail(`saveAudio 不該抛錯（要安靜降級），實際：${err?.message || err}`);
  }
  assert.ok(res, 'saveAudio 一定要 resolve');
  assert.equal(res.ok, false, '寫入失敗要回報 ok:false');
  assert.ok(res.reason, '要帶失敗原因方便除錯');
  // 失敗後讀取仍要能安全回 null
  assert.equal(await loadAudio(), null);
});

// ── 形象照片（跟音檔共用同一個 store，但不同 key）───────────────
import { savePhoto, loadPhoto, clearPhoto, hasPhoto } from '../src/audio/cache.js';

test('photo cache：存讀照片，且不會蓋掉音檔', async () => {
  setFake(makeFakeIndexedDB());
  const audio = makeFile('fake-audio', 'Night Shift.wav', 'audio/wav');
  const photo = makeFile('fake-photo-bytes', 'sombra.png', 'image/png');

  assert.equal((await saveAudio(audio)).ok, true);
  assert.equal((await savePhoto(photo)).ok, true);

  const a = await loadAudio();
  const p = await loadPhoto();
  assert.equal(a.name, 'Night Shift.wav', '音檔不該被照片蓋掉');
  assert.equal(p.name, 'sombra.png');
  assert.equal(new TextDecoder().decode(await p.file.arrayBuffer()), 'fake-photo-bytes');
  assert.equal(await hasPhoto(), true);
});

test('photo cache：清除照片不影響音檔（重設才是全部清）', async () => {
  setFake(makeFakeIndexedDB());
  await saveAudio(makeFile('audio-1', 'a.wav'));
  await savePhoto(makeFile('photo-1', 'p.jpg'));

  assert.equal(await clearPhoto(), true);
  assert.equal(await hasPhoto(), false);
  assert.equal((await loadAudio())?.name, 'a.wav', '清照片不該動到音檔');

  assert.equal(await clearAudio(), true);
  assert.equal(await hasAudio(), false);
});

test('photo cache：沒有 IndexedDB 時安靜降級', async () => {
  delete globalThis.indexedDB;
  assert.equal(await loadPhoto(), null);
  assert.equal(await hasPhoto(), false);
  const res = await savePhoto(makeFile('x'));
  assert.equal(res.ok, false);
});

// ── 3D 角色模型（VRM / GLB）────────────────────────────────
import { saveAvatar, loadAvatar, clearAvatar, hasAvatar } from '../src/audio/cache.js';

test('avatar cache：存讀 3D 模型，且不影響音檔/照片', async () => {
  setFake(makeFakeIndexedDB());
  await saveAudio(makeFile('audio-x', 'a.wav'));
  await savePhoto(makeFile('photo-x', 'p.jpg'));
  const glb = makeFile('glTF-binary-bytes', 'sombra.vrm', 'model/gltf-binary');

  const res = await saveAvatar(glb);
  assert.equal(res.ok, true, `存模型應成功，實際 ${JSON.stringify(res)}`);

  const loaded = await loadAvatar();
  assert.ok(loaded, '應讀得回模型');
  assert.equal(loaded.name, 'sombra.vrm');
  assert.equal(new TextDecoder().decode(await loaded.file.arrayBuffer()), 'glTF-binary-bytes');
  // 三個 key 互不覆蓋
  assert.equal((await loadAudio())?.name, 'a.wav');
  assert.equal((await loadPhoto())?.name, 'p.jpg');
  assert.equal(await hasAvatar(), true);
});

test('avatar cache：清除模型不影響其他媒體', async () => {
  setFake(makeFakeIndexedDB());
  await saveAvatar(makeFile('m', 'x.glb'));
  await saveAudio(makeFile('a', 'a.wav'));

  assert.equal(await clearAvatar(), true);
  assert.equal(await hasAvatar(), false);
  assert.equal((await loadAudio())?.name, 'a.wav', '清模型不該動到音檔');
});

test('avatar cache：沒有 IndexedDB 時安靜降級', async () => {
  delete globalThis.indexedDB;
  assert.equal(await loadAvatar(), null);
  assert.equal(await hasAvatar(), false);
  assert.equal((await saveAvatar(makeFile('m'))).ok, false);
});
