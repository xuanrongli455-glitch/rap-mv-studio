// rap-mv/src/main.js — 整合層（Lead 擁有，不要改）
// 職責：把 config / 3D 場景 / 音訊 / 錄影 / UI 串起來，提供一個確定性的時間軸。
import { loadConfig, saveConfig, RATIOS, PALETTES, CONFIG_STORAGE_KEY } from './config.js';
import { createScene } from './scene/index.js';
import { createAudio } from './audio/audio.js';
import { createRecorder, saveBlob } from './record/recorder.js';
import { saveAudio, loadAudio, clearAudio } from './audio/cache.js';
import { createPanel } from './ui/panel.js';
import { syntheticStats } from './lib/beat.js';
import { formatTime, clamp } from './lib/timeline.js';

const canvas = document.getElementById('stage-canvas');
const $ = (id) => document.getElementById(id);
const hud = $('hud');
const hudTime = $('hud-time');
const hudName = $('hud-name');
const overlay = $('overlay');
const ovCount = $('overlay-count');
const ovBig = $('overlay-big');
const ovMsg = $('overlay-msg');

let config = loadConfig();
const state = {
  mode: 'idle',        // idle | preview | recording | finishing
  t: 0,                // 影片時間（秒）
  t0: 0,               // 本段播放/錄影的起始 wall clock
  previewStart: 0,
  raf: 0,
  lastFrameT: -1,
  audioInfo: null,
};

// 著陸畫面時間：t=0 時標題粒子還在四散，看起來像沒有字 → 停在標題已聚合成字的位置。
// 標題聚合進度是 p = t/introEnd，而 introEnd = 0.13×duration（分鏡等比縮放），
// 所以要跟著 duration 走、不能寫死 1.5 秒（62 秒的片會停在 p=0.18，標題半散開）。
// duration×7.5% → p≈0.58（聚合完成、離炸散還早）。短片用 duration×20% 封頂。
function landingT() {
  return clamp(config.duration * 0.075, 0.2, config.duration * 0.2);
}

// ── 畫布尺寸：固定成輸出解析度，CSS 負責縮放 ──
function applyCanvasSize() {
  const r = RATIOS[config.ratio] || RATIOS['9:16'];
  canvas.width = r.w;
  canvas.height = r.h;
  canvas.style.aspectRatio = `${r.w} / ${r.h}`;
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.maxHeight = '100%';
  scene.resize(r.w, r.h);
}

// ── 建立場景 ──
let scene;
try {
  scene = createScene({ canvas, config });
} catch (err) {
  console.error('[mv] 場景建立失敗', err);
  $('nogl').style.display = 'grid';
  throw err;
}
applyCanvasSize();
const audio = await createAudio();
const recorder = createRecorder({ canvas, getAudioStream: () => audio.getStream() });

// ── 動作表：必須在 createPanel 之前定義（面板會立刻用到這個物件參照）──
const actions = {
  play: startPreview,
  pause: pausePreview,
  record: startRecording,
  stopRecord: stopRecording,
  reset: resetConfig,
  applyConfig,
  loadAudio: loadAudioFile,
  snapshot,
  seek: seekTo,
};

// ── UI（若面板模組壞掉，不能讓整個 App 白屏：降級成無操作面板）──
let panel;
try {
  panel = createPanel({
    config,
    onChange: (patch) => applyConfig(patch),
    audio,
    recorder,
    actions,
  });
} catch (err) {
  console.error('[mv] 面板建立失敗，降級為無 UI 模式', err);
  if (window.__MV_SHOW_ERROR__) window.__MV_SHOW_ERROR__('面板', err?.message || String(err));
  panel = {
    refresh() {}, setStatus() {}, setRecording() {}, setProgress() {}, dispose() {},
  };
}

// ── 工具 ──
function currentStats(t) {
  try {
    const s = audio.getStats(t);
    if (s && typeof s.rms === 'number') return s;
  } catch (err) {
    console.warn('[mv] audio.getStats 失敗，改用合成節拍', err);
  }
  return syntheticStats(t, config.bpm, config.duration);
}

function setHudTime(t) {
  hudTime.textContent = `${t.toFixed(1)}s`;
}

function showOverlay(kind, big, msg) {
  overlay.classList.add('show');
  ovCount.textContent = kind === 'count' ? String(big) : '';
  ovBig.textContent = kind === 'count' ? '' : String(big || '');
  ovMsg.textContent = msg || '';
}
function hideOverlay() {
  overlay.classList.remove('show');
}
function setLive(on) {
  hud.classList.toggle('live', on);
}

// ── 主迴圈：確定性時間軸 ──
function frame(now) {
  state.raf = requestAnimationFrame(frame);

  if (state.mode === 'recording') {
    state.t = (now - state.t0) / 1000;
    if (state.t >= config.duration) {
      state.t = config.duration;
      renderFrame(state.t);
      finishRecording();
      return;
    }
  } else if (state.mode === 'preview') {
    // 用壁鐘當視覺時鐘：歌比 MV 短、或音訊解碼慢、或播放卡住，畫面都不會凍住。
    const raw = (now - state.previewStart) / 1000;
    state.t = raw % config.duration;
    if (raw >= config.duration) {
      // 循環試看：畫面和音樂一起回到 0
      restartPreviewClock();
      state.t = 0;
    }
  } else {
    // idem：靜止在目前時間，讓使用者調參數看效果
    // 若使用者拖動時間軸就用 state.t
  }

  renderFrame(state.t);
  setHudTime(state.t);
  try {
    panel.setProgress(config.duration ? clamp(state.t / config.duration, 0, 1) : 0, state.t);
  } catch { /* UI 未就緒 */ }
}

function renderFrame(t) {
  // 避免同一秒重複 render 太多次（錄影時仍每幀更新，這裡只做節流保護）
  const stats = currentStats(t);
  scene.update(t, stats);
  scene.render();
  state.lastFrameT = t;
}

function restartPreviewClock() {
  // 視覺時間軸一律跟壁鐘走（audio 模組若歌比 MV 短 / 播完 / 卡住，畫面都不會凍住）；
  // 音樂從同一個瞬間開始播，20 秒內不會有可感知的漂移。
  state.previewStart = performance.now();
  if (audio.isLoaded()) {
    try {
      audio.seek(0);
      audio.play(0);
    } catch (err) {
      console.warn('[mv] 音樂播放失敗（畫面照跑）', err);
    }
  }
}

// ── 播放控制 ──
async function startPreview() {
  if (state.mode === 'recording') return;
  try { await audio.ensureContext(); } catch (err) { console.warn('[mv] AudioContext 未就緒', err); }
  state.mode = 'preview';
  restartPreviewClock();
  setLive(true);
  panel.setStatus(audio.isLoaded() ? '試看中（含音樂）' : '試看中（無音檔，僅節拍動態）', 'info');
}

function pausePreview() {
  if (state.mode === 'recording') return;
  state.mode = 'idle';
  audio.pause();
  setLive(false);
  panel.setStatus('已暫停', 'info');
}

function seekTo(t) {
  const v = clamp(t, 0, config.duration);
  state.t = v;
  if (state.mode === 'preview') {
    state.previewStart = performance.now() - v * 1000;
    if (audio.isLoaded()) {
      try { audio.seek(v); } catch (err) { console.warn('[mv] seek 失敗', err); }
    }
  }
  renderFrame(v);
  panel.refresh(config);
}

// ── 錄影 ──
async function startRecording() {
  if (state.mode === 'recording' || state.mode === 'finishing') return;
  if (!recorder.isSupported()) {
    panel.setStatus('這個瀏覽器不支援錄影（請用 Safari 16.4+ 或 Chrome）', 'error');
    return;
  }
  try { await audio.ensureContext(); } catch (err) { console.warn('[mv] AudioContext 未就緒', err); }
  // 倒數期間不能有音樂：先停掉試看中的播放，並把狀態切成 idle（迴圈才不會繼續推進時間）
  state.mode = 'idle';
  setLive(false);
  audio.pause();
  audio.seek(0);
  state.t = 0;
  renderFrame(0); // 先畫一幀，captureStream 才抓得到影像

  // 3-2-1 倒數
  for (const n of [3, 2, 1]) {
    showOverlay('count', n, audio.isLoaded() ? '音樂會同步開始' : '未載入音檔 → 這次輸出無聲');
    panel.setStatus(`倒數 ${n}`, 'warn');
    await sleep(700);
  }
  hideOverlay();

  try {
    await recorder.start({ fps: config.fps });
  } catch (err) {
    console.error('[mv] recorder.start 失敗', err);
    panel.setStatus('無法開始錄影：' + (err?.message || err), 'error');
    return;
  }

  if (audio.isLoaded()) {
    try { audio.play(0); } catch (err) { console.warn('[mv] 錄影時音樂起播失敗（輸出會無聲）', err); }
  }
  state.mode = 'recording';
  state.t0 = performance.now();
  setLive(true);
  panel.setRecording(true);
  panel.setStatus('錄影中… 請不要切換到別的 App', 'warn');
}

async function finishRecording() {
  if (state.mode === 'finishing') return;
  state.mode = 'finishing';
  audio.stop();
  setLive(false);
  showOverlay('done', '正在打包影片…', '20 秒的 3D 影格處理中，請稍等');
  let out = null;
  try {
    out = await recorder.stop();
  } catch (err) {
    console.error('[mv] recorder.stop 失敗', err);
  }
  panel.setRecording(false);
  panel.setStatus('', 'info');

  if (!out || !out.blob || out.blob.size === 0) {
    hideOverlay();
    state.mode = 'idle';
    panel.setStatus('錄影失敗：沒有產生資料', 'error');
    return;
  }
  saveBlob(out.blob, out.filename);
  hideOverlay();
  state.mode = 'idle';
  state.t = landingT(); // 錄完回到著陸畫面（不歸 0，否則畫面像沒字）
  renderFrame(state.t);
  panel.setStatus(`完成！已儲存 ${out.filename}（${(out.blob.size / 1048576).toFixed(1)} MB）`, 'ok');
}

function stopRecording() {
  if (state.mode !== 'recording') return;
  finishRecording();
}

// ── 設定 ──
function applyConfig(patch) {
  const prevRatio = config.ratio;
  const prevBpm = config.bpm;
  config = { ...config, ...patch };
  saveConfig(config);
  window.__MV_CONFIG__ = config;
  if (config.ratio !== prevRatio) applyCanvasSize();
  // BPM 改了要通知節拍追蹤器重建格線，否則畫面脈動還對舊的 BPM
  if (config.bpm !== prevBpm) {
    try { audio.setBpm(config.bpm); } catch (err) { console.warn('[mv] audio.setBpm 失敗', err); }
  }
  try { scene.setConfig(config); } catch (err) { console.error('[mv] scene.setConfig 失敗', err); }
  try { panel.refresh(config); } catch { /* ignore */ }
  hudName.textContent = `${config.artist} — ${config.title}`;
  // 立即反映在畫面上。注意 idle 也要用 state.t，不能寫死 0：
  // 著陸畫面刻意停在 landingT()（標題粒子已聚合成字），歸 0 會讓粒子散開、看起來像沒字。
  renderFrame(clamp(state.t, 0, config.duration));
}

function resetConfig() {
  audio.stop();
  try { localStorage.removeItem(CONFIG_STORAGE_KEY); } catch { /* ignore */ }
  // 「重設」是全部歸零：連這台裝置記住的音檔一起清掉
  clearAudio().catch(() => {});
  location.reload();
}

// 選錯檔案時給「人話」——比「無法解碼這個音訊檔」有用得多
function audioErrorMessage(file, err) {
  const name = String((file && file.name) || '這個檔案');
  const type = String((file && file.type) || '');
  if (/^image\//i.test(type) || /\.(png|jpe?g|heic|heif|gif|webp|bmp|tiff?)$/i.test(name)) {
    return `「${name}」是圖片，不是音檔——請選 .wav / .mp3 / .m4a`;
  }
  if (/^video\//i.test(type) || /\.(mov|mkv|avi|webm)$/i.test(name)) {
    return `「${name}」是影片，不是音檔——請改選音檔`;
  }
  const raw = err && err.message ? err.message : String(err);
  return `音檔載入失敗（${name}）：${raw}。支援 mp3 / m4a / wav（wav 較大，解碼要等一下）`;
}

async function loadAudioFile(file, { fromCache = false } = {}) {
  if (!file) return;
  panel.setStatus(fromCache ? '還原上次的歌…' : '分析音檔中…', 'info');
  try {
    const info = await audio.loadFile(file);
    state.audioInfo = info;
    applyConfig({ bpm: info.bpm || config.bpm });
    panel.setStatus(
      `已載入「${info.name}」 ${formatTime(info.duration)} · 偵測 BPM ${info.bpm}` +
        (info.bpm ? '' : '（未偵測到，請手動填）') +
        (fromCache ? ' · 已記住，下次開啟自動載入' : ''),
      'ok',
    );
    // 使用者自己選的檔案才寫入本機快取（從快取還原的就不再寫一次）
    if (!fromCache) {
      saveAudio(file).then((res) => {
        if (!res.ok && res.reason) console.warn('[mv] 音檔無法存進本機快取', res.reason);
      });
    }
  } catch (err) {
    console.error('[mv] 音檔載入失敗', err);
    panel.setStatus(audioErrorMessage(file, err), 'error');
  }
}

// 開啟頁面時把上次的歌接回來（只在這台裝置、存在 IndexedDB，不上傳）。
// iOS 上沒有使用者手勢時 AudioContext 可能是 suspended，解碼若失敗就等第一次觸碰再試。
async function restoreCachedAudio() {
  let cached = null;
  try {
    cached = await loadAudio();
  } catch {
    return false;
  }
  if (!cached || !cached.file) return false;
  try {
    await loadAudioFile(cached.file, { fromCache: true });
    return true;
  } catch (err) {
    console.warn('[mv] 還原上次的音檔失敗', err);
    return false;
  }
}

function armRestoreOnFirstGesture() {
  const once = () => {
    window.removeEventListener('pointerdown', once, true);
    window.removeEventListener('keydown', once, true);
    restoreCachedAudio().catch(() => {});
  };
  window.addEventListener('pointerdown', once, true);
  window.addEventListener('keydown', once, true);
}

function snapshot() {
  const r = RATIOS[config.ratio] || RATIOS['9:16'];
  const name = `${config.artist}-${config.title}-still-${state.t.toFixed(1)}s.png`.replace(/[\\/:*?"<>|\s]+/g, '_');
  canvas.toBlob((blob) => {
    if (!blob) return;
    saveBlob(blob, name);
    panel.setStatus(`已存海報 ${name}`, 'ok');
  }, 'image/png');
}

// ── 啟動 ──
window.__MV = { state, get config() { return config; }, scene, audio, recorder, panel, actions };
hudName.textContent = `${config.artist} — ${config.title}`;
window.__MV_CONFIG__ = config;
// 著陸畫面停在「標題粒子已聚合成字」的位置：t=0 時粒子還在四散，打開頁面會像沒有字。
// 按「試看」仍然從 0 秒開始播完整分鏡。
state.t = landingT();
renderFrame(state.t);
state.raf = requestAnimationFrame(frame);
panel.setStatus('準備好了：填歌名/藝名 → 上傳音樂 → 按「錄製成片」', 'info');
// 上次載入過的歌會自動接回來（只在這台裝置）；失敗就等第一次觸碰再試
restoreCachedAudio()
  .then((restored) => { if (!restored) armRestoreOnFirstGesture(); })
  .catch(() => armRestoreOnFirstGesture());

// 切成背景時暫停試看，避免耗電
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'preview') pausePreview();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
