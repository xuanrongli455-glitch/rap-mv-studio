// rap-mv/src/ui/panel.js — 控制面板（手機底部抽屜 / 桌面右側固定）
//
// 為什麼自己組 DOM 而不是在 index.html 寫死：
//   合約規定 UI 模組只掛在 #panel 上，index.html 由 Lead 擁有；
//   面板的欄位數量多，用一個靜態 template + JS 補值最好維護，
//   而且能保證所有動態文字都走 textContent / value（不會有 HTML injection）。
//
// 幾個關鍵設計：
//   1) 所有 config → 欄位的同步都走 refresh()，並用 `syncing` 旗標避免
//      「refresh 設定 value → input 事件 → onChange → main → refresh」無限迴圈。
//   2) 使用者正在打字的欄位（document.activeElement）不會被 refresh 覆蓋，
//      否則 main.js 每次 applyConfig 都會把游標洗掉。
//   3) 滑桿與時間軸用 requestAnimationFrame 合併成一次 onChange，
//      避免拖動時每個 input 事件都觸發一次 3D 重繪。
//   4) 這個模組不 import three（UI 不需要 3D，少載一點是一點）。

import { PALETTES } from '../config.js';
import { autoDistributeLyrics, formatTime } from '../lib/timeline.js';

const RANGE_KEYS = ['intensity', 'shake', 'bloom', 'grain'];
const TOGGLE_KEYS = ['showCity', 'showVinyl', 'showMic', 'showParticles', 'showLyrics', 'showRain'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

function errText(err) {
  return (err && err.message) || String(err);
}

function debounce(fn, ms) {
  let id = 0;
  return function debounced(...args) {
    clearTimeout(id);
    id = setTimeout(() => {
      id = 0;
      fn.apply(null, args);
    }, ms);
  };
}

function isMobileViewport() {
  try {
    return window.matchMedia('(max-width: 820px)').matches;
  } catch {
    try { return window.innerWidth <= 820; } catch { return true; }
  }
}

function noop() {}

function makeNoopAPI() {
  return { refresh: noop, setStatus: noop, setRecording: noop, setProgress: noop, dispose: noop };
}

// 靜態骨架：所有使用者資料都用 JS 的 value/textContent 補，不放進 innerHTML。
const PANEL_HTML = `
<div class="p-grab" id="p-grab" aria-hidden="true"><i></i></div>
<header class="p-head" id="p-head" role="button" tabindex="0" aria-label="開合設定面板">
  <div class="p-head-t">
    <span class="p-kicker">3D RAP MV STUDIO</span>
    <strong>MV 控制台</strong>
  </div>
  <span class="p-rec" id="p-rec" aria-hidden="true"><i></i>REC</span>
  <button type="button" class="p-x" id="p-x" aria-label="收起面板">✕</button>
</header>
<div class="p-body" id="p-body">
  <section class="grp">
    <h3 class="grp-t">基本資料</h3>
    <label class="fld"><span>歌名</span><input id="f-title" type="text" autocomplete="off" enterkeyhint="done" placeholder="夜行者" maxlength="40"></label>
    <label class="fld"><span>藝名</span><input id="f-artist" type="text" autocomplete="off" enterkeyhint="done" placeholder="DIZZY 24" maxlength="30"></label>
    <label class="fld"><span>標語</span><input id="f-tagline" type="text" autocomplete="off" enterkeyhint="done" placeholder="NEW SINGLE" maxlength="24"></label>
    <label class="fld"><span>CTA</span><input id="f-cta" type="text" autocomplete="off" enterkeyhint="done" placeholder="OUT NOW" maxlength="16"></label>
  </section>

  <section class="grp">
    <h3 class="grp-t">歌詞<span class="grp-hint" id="f-lyrics-hint">一行一句</span></h3>
    <textarea id="f-lyrics" rows="4" placeholder="一行一句歌詞…" spellcheck="false" autocapitalize="off"></textarea>
    <div class="row">
      <button type="button" class="btn btn-sm" id="btn-lyrics" data-lock>套用歌詞與時間軸</button>
    </div>
  </section>

  <section class="grp">
    <h3 class="grp-t">規格</h3>
    <div class="pills" id="ratio-pills" role="group" aria-label="畫面比例">
      <button type="button" class="pill" data-ratio="9:16">9:16</button>
      <button type="button" class="pill" data-ratio="16:9">16:9</button>
      <button type="button" class="pill" data-ratio="1:1">1:1</button>
    </div>
    <div class="fld-row">
      <label class="fld fld-bpm"><span>BPM</span><input id="f-bpm" type="number" inputmode="numeric" min="60" max="200" step="0.1" value="92"></label>
      <span class="badge" id="f-bpm-auto" data-state="idle">自動偵測 —</span>
    </div>
  </section>

  <section class="grp">
    <h3 class="grp-t">主題色</h3>
    <div class="swatches" id="palette-swatches"></div>
  </section>

  <section class="grp">
    <h3 class="grp-t">動態強度</h3>
    <label class="fld fld-range"><span>強度</span><input id="f-intensity" type="range" min="0" max="1" step="0.05"><output id="v-intensity">0.85</output></label>
    <label class="fld fld-range"><span>震動</span><input id="f-shake" type="range" min="0" max="1" step="0.05"><output id="v-shake">0.45</output></label>
    <label class="fld fld-range"><span>光暈</span><input id="f-bloom" type="range" min="0" max="1" step="0.05"><output id="v-bloom">0.90</output></label>
    <label class="fld fld-range"><span>顆粒</span><input id="f-grain" type="range" min="0" max="1" step="0.05"><output id="v-grain">0.35</output></label>
  </section>

  <section class="grp">
    <h3 class="grp-t">場景元素</h3>
    <div class="checks">
      <label class="chk"><input type="checkbox" id="f-showCity"><span>城市</span></label>
      <label class="chk"><input type="checkbox" id="f-showVinyl"><span>黑膠</span></label>
      <label class="chk"><input type="checkbox" id="f-showMic"><span>麥克風</span></label>
      <label class="chk"><input type="checkbox" id="f-showParticles"><span>粒子</span></label>
      <label class="chk"><input type="checkbox" id="f-showLyrics"><span>歌詞</span></label>
      <label class="chk"><input type="checkbox" id="f-showRain"><span>雨</span></label>
    </div>
  </section>

  <section class="grp">
    <h3 class="grp-t">音樂</h3>
    <label class="file-btn" for="f-audio">🎵 上傳音檔（mp3 / m4a / wav）</label>
    <input id="f-audio" type="file" accept="audio/*" hidden>
    <p class="meta" id="f-audio-meta" data-loaded="0">尚未載入音檔 → 錄影會是無聲影片</p>
  </section>

  <section class="grp">
    <h3 class="grp-t">時間軸</h3>
    <div class="seek-row">
      <input id="f-seek" type="range" min="0" max="20" step="0.1" value="0" aria-label="時間軸">
      <span class="seek-time" id="f-seek-time">0:00.0</span>
    </div>
  </section>

  <section class="grp">
    <h3 class="grp-t">動作</h3>
    <div class="btns">
      <button type="button" class="btn" id="btn-play" data-lock>▶ 試看</button>
      <button type="button" class="btn" id="btn-pause" data-lock>⏸ 暫停</button>
      <button type="button" class="btn btn-rec" id="btn-record" data-lock>● 錄製成片</button>
      <button type="button" class="btn" id="btn-stop" disabled>■ 停止</button>
      <button type="button" class="btn" id="btn-snap" data-lock>📷 存海報</button>
      <button type="button" class="btn btn-ghost" id="btn-reset" data-lock>↺ 重設</button>
    </div>
  </section>
</div>
<footer class="p-foot">
  <div class="p-prog"><i id="p-prog-fill"></i></div>
  <div class="p-status-row">
    <span class="p-status" id="p-status" data-kind="info">準備好了</span>
    <span class="p-time" id="p-prog-time">0:00.0 / 0:20.0</span>
  </div>
</footer>
`;

export function createPanel({ config, onChange, audio, recorder, actions } = {}) {
  // 這個模組只在瀏覽器跑；但還是用 try/catch 包住，
  // 萬一被拿去 SSR / 測試環境（沒有 document）也不能在頂層就丟錯。
  const byId = (id) => {
    try { return document.getElementById(id); } catch { return null; }
  };
  const panel = byId('panel');
  if (!panel) return makeNoopAPI(); // 掛載點不存在：回安全 no-op

  const onChangeSafe = typeof onChange === 'function' ? onChange : noop;

  // ── 狀態 ──
  let cfg = config && typeof config === 'object' ? config : {};
  let syncing = false;        // refresh() 寫值時為 true，避免觸發 onChange 迴圈
  let recording = false;
  let seeking = false;        // 使用者正在拖時間軸
  let seekIdleTimer = 0;      // 手指放開事件沒收到時的保險計時器
  let lastProgress = -1;
  let lastTimeText = '';
  let lastSeconds = 0;
  let patchRaf = 0;
  const pendingPatch = {};

  // 事件統一用 AbortController 管，dispose() 一次移除，避免漏 listener
  let ac = null;
  try { ac = new AbortController(); } catch { ac = null; }
  const signal = ac ? ac.signal : undefined;

  function on(el, type, handler) {
    if (!el || typeof el.addEventListener !== 'function') return;
    try {
      if (signal) el.addEventListener(type, handler, { signal });
      else el.addEventListener(type, handler);
    } catch {
      try { el.addEventListener(type, handler); } catch { /* 真的不行就算了 */ }
    }
  }

  function $(sel) {
    try { return panel.querySelector(sel); } catch { return null; }
  }

  // ── 建 DOM ──
  try {
    panel.innerHTML = PANEL_HTML;
  } catch (err) {
    console.warn('[panel] 無法建立面板內容', err);
    return makeNoopAPI();
  }

  const els = {
    grab: $('#p-grab'),
    head: $('#p-head'),
    body: $('#p-body'),
    closeBtn: $('#p-x'),
    title: $('#f-title'),
    artist: $('#f-artist'),
    tagline: $('#f-tagline'),
    cta: $('#f-cta'),
    lyrics: $('#f-lyrics'),
    lyricsHint: $('#f-lyrics-hint'),
    btnLyrics: $('#btn-lyrics'),
    ratioWrap: $('#ratio-pills'),
    bpm: $('#f-bpm'),
    bpmAuto: $('#f-bpm-auto'),
    paletteWrap: $('#palette-swatches'),
    audioInput: $('#f-audio'),
    audioMeta: $('#f-audio-meta'),
    seek: $('#f-seek'),
    seekTime: $('#f-seek-time'),
    status: $('#p-status'),
    progFill: $('#p-prog-fill'),
    progTime: $('#p-prog-time'),
    btnPlay: $('#btn-play'),
    btnPause: $('#btn-pause'),
    btnRecord: $('#btn-record'),
    btnStop: $('#btn-stop'),
    btnSnap: $('#btn-snap'),
    btnReset: $('#btn-reset'),
    toggle: byId('panel-toggle'),
  };

  // ── 色票：用 PALETTES 的 key/accent 做漸層預覽 ──
  try {
    if (els.paletteWrap) {
      for (const key of Object.keys(PALETTES)) {
        const p = PALETTES[key] || {};
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch';
        btn.dataset.palette = key;
        btn.style.setProperty('--sw-a', p.key || '#00e5ff');
        btn.style.setProperty('--sw-b', p.accent || '#ff2bd6');
        btn.setAttribute('aria-label', '主題色：' + (p.label || key));
        btn.setAttribute('aria-pressed', 'false');
        const fill = document.createElement('i');
        const label = document.createElement('span');
        label.textContent = p.label || key;
        btn.appendChild(fill);
        btn.appendChild(label);
        els.paletteWrap.appendChild(btn);
      }
    }
  } catch (err) {
    console.warn('[panel] 主題色按鈕建立失敗', err);
  }

  // ── 共用小工具 ──
  function duration() {
    const d = Number(cfg && cfg.duration);
    return Number.isFinite(d) && d > 0 ? d : 20;
  }

  function audioLoaded() {
    try { return !!(audio && typeof audio.isLoaded === 'function' && audio.isLoaded()); } catch { return false; }
  }

  function lyricsToText(lyrics) {
    try {
      if (!Array.isArray(lyrics)) return '';
      return lyrics.map((l) => (typeof l === 'string' ? l : (l && l.text) || '')).join('\n');
    } catch (_err) {
      return '';
    }
  }

  function setInputValue(el, value) {
    if (!el) return;
    // 使用者正在編輯的欄位不要覆蓋（否則 main.applyConfig → refresh 會洗掉游標）
    try { if (document.activeElement === el) return; } catch { /* ignore */ }
    const v = value == null ? '' : String(value);
    try { if (el.value !== v) el.value = v; } catch { /* ignore */ }
  }

  function formatSafe(sec) {
    try { return formatTime(sec); } catch (_err) { return '0:00.0'; }
  }

  // ── 動作分派：actions 由 main.js 傳進來；保險起見也接受晚到的 window.__MV.actions ──
  function getAction(name) {
    try {
      if (actions && typeof actions[name] === 'function') return actions[name];
      const live = typeof window !== 'undefined' && window.__MV ? window.__MV.actions : null;
      if (live && typeof live[name] === 'function') return live[name];
    } catch { /* ignore */ }
    return null;
  }

  function runAction(name, ...args) {
    const fn = getAction(name);
    if (!fn) {
      setStatus('「' + name + '」還沒準備好', 'warn');
      return;
    }
    try {
      const p = fn(...args);
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          console.error('[panel] action ' + name + ' 失敗', err);
          setStatus('操作失敗：' + errText(err), 'error');
        });
      }
    } catch (err) {
      console.error('[panel] action ' + name + ' 失敗', err);
      setStatus('操作失敗：' + errText(err), 'error');
    }
  }

  // 滑桿/拖動用：同一個 animation frame 內的多次變更合併成一次 onChange
  function queuePatch(patch) {
    try { Object.assign(pendingPatch, patch); } catch { /* ignore */ }
    if (patchRaf) return;
    try {
      patchRaf = requestAnimationFrame(() => {
        patchRaf = 0;
        const out = {};
        for (const k of Object.keys(pendingPatch)) {
          out[k] = pendingPatch[k];
          delete pendingPatch[k];
        }
        try { onChangeSafe(out); } catch (err) { console.error('[panel] onChange 失敗', err); }
      });
    } catch (_err) {
      // requestAnimationFrame 不存在（極端環境）→ 直接送
      try { onChangeSafe({ ...pendingPatch }); } catch { /* ignore */ }
      for (const k of Object.keys(pendingPatch)) delete pendingPatch[k];
    }
  }

  // ───────────────────────── refresh / 顯示同步 ─────────────────────────

  function updateRatioActive(override) {
    try {
      if (!els.ratioWrap) return;
      const active = override || (cfg && cfg.ratio);
      const btns = els.ratioWrap.querySelectorAll('[data-ratio]');
      for (const b of btns) {
        const isOn = b.dataset.ratio === active;
        b.classList.toggle('active', isOn);
        b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      }
    } catch (err) {
      console.warn('[panel] 比例按鈕狀態更新失敗', err);
    }
  }

  function updatePaletteActive(override) {
    try {
      if (!els.paletteWrap) return;
      const active = override || (cfg && cfg.palette);
      const btns = els.paletteWrap.querySelectorAll('[data-palette]');
      for (const b of btns) {
        const isOn = b.dataset.palette === active;
        b.classList.toggle('active', isOn);
        b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      }
    } catch (err) {
      console.warn('[panel] 色票狀態更新失敗', err);
    }
  }

  function updateBpmBadge() {
    try {
      if (!els.bpmAuto) return;
      let detected = null;
      try {
        if (audio && typeof audio.getDetectedBpm === 'function') detected = audio.getDetectedBpm();
      } catch (_err) { detected = null; }
      if (detected) {
        els.bpmAuto.textContent = '自動偵測 ' + Math.round(Number(detected) * 10) / 10;
        els.bpmAuto.dataset.state = 'ok';
      } else if (audioLoaded()) {
        els.bpmAuto.textContent = '未偵測到（可手動填）';
        els.bpmAuto.dataset.state = 'warn';
      } else {
        els.bpmAuto.textContent = '自動偵測 —';
        els.bpmAuto.dataset.state = 'idle';
      }
    } catch (_err) { /* 顯示失敗不影響功能 */ }
  }

  function updateAudioMeta() {
    try {
      if (!els.audioMeta) return;
      let info = null;
      try {
        if (audio && typeof audio.getInfo === 'function') info = audio.getInfo();
      } catch (_err) { info = null; }
      if (info && info.name) {
        const bpmTxt = info.bpm ? ' · ' + Math.round(Number(info.bpm)) + ' BPM' : ' · BPM 未偵測';
        els.audioMeta.textContent = '🎵 ' + info.name + ' · ' + formatSafe(info.duration) + bpmTxt;
        els.audioMeta.dataset.loaded = '1';
      } else {
        els.audioMeta.textContent = '尚未載入音檔 → 錄影會是無聲影片';
        els.audioMeta.dataset.loaded = '0';
      }
    } catch (err) {
      console.warn('[panel] 音檔資訊更新失敗', err);
    }
  }

  function refresh(nextConfig) {
    if (nextConfig && typeof nextConfig === 'object') cfg = nextConfig;
    if (!cfg || typeof cfg !== 'object') return;

    syncing = true;
    try {
      setInputValue(els.title, cfg.title);
      setInputValue(els.artist, cfg.artist);
      setInputValue(els.tagline, cfg.tagline);
      setInputValue(els.cta, cfg.cta);

      // 歌詞：不要在使用者輸入時覆蓋
      if (els.lyrics) {
        try {
          if (document.activeElement !== els.lyrics) els.lyrics.value = lyricsToText(cfg.lyrics);
        } catch { /* ignore */ }
      }
      if (els.lyricsHint) els.lyricsHint.textContent = '一行一句 · 自動分配 ' + duration() + ' 秒';

      updateRatioActive();
      setInputValue(els.bpm, cfg.bpm);
      updateBpmBadge();
      updatePaletteActive();

      for (const key of RANGE_KEYS) {
        const el = byId('f-' + key);
        setInputValue(el, cfg[key]);
        const out = byId('v-' + key);
        if (out) out.textContent = Number(cfg[key] || 0).toFixed(2);
      }

      for (const key of TOGGLE_KEYS) {
        const el = byId('f-' + key);
        if (el) el.checked = !!cfg[key];
      }

      if (els.seek) {
        try { els.seek.max = String(duration()); } catch { /* ignore */ }
      }
      if (els.seekTime) els.seekTime.textContent = formatSafe(lastSeconds);

      updateAudioMeta();
    } catch (err) {
      console.warn('[panel] refresh 失敗', err);
    } finally {
      syncing = false;
    }
  }

  // ───────────────────────── 欄位事件 ─────────────────────────

  // 文字欄位：debounce 250ms，避免每打一個字就重繪 3D
  const textFields = [
    ['title', els.title],
    ['artist', els.artist],
    ['tagline', els.tagline],
    ['cta', els.cta],
  ];
  for (const [key, el] of textFields) {
    if (!el) continue;
    const push = debounce(() => {
      if (syncing) return;
      try { onChangeSafe({ [key]: String(el.value || '') }); } catch (err) { console.error('[panel] onChange 失敗', err); }
    }, 250);
    on(el, 'input', () => { if (!syncing) push(); });
  }

  // 歌詞：按「套用」才重算時間軸（一行一句 → autoDistributeLyrics）
  function applyLyrics() {
    try {
      if (!els.lyrics) return;
      const lines = String(els.lyrics.value || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 30);
      if (!lines.length) {
        setStatus('歌詞至少要有一行', 'warn');
        return;
      }
      let lyrics = null;
      try {
        lyrics = autoDistributeLyrics(lines, duration());
      } catch (err) {
        console.warn('[panel] autoDistributeLyrics 失敗，改用本地均分', err);
        lyrics = null;
      }
      if (!Array.isArray(lyrics) || !lyrics.length) lyrics = fallbackDistribute(lines, duration());
      onChangeSafe({ lyrics });
      setStatus('已套用 ' + lyrics.length + ' 行歌詞並重算時間軸', 'ok');
    } catch (err) {
      console.warn('[panel] 套用歌詞失敗', err);
      setStatus('套用歌詞失敗：' + errText(err), 'error');
    }
  }

  // lib/timeline 壞掉時的最後手段：前端 14%~86% 均分
  function fallbackDistribute(lines, total) {
    const lead = total * 0.14;
    const tail = total * 0.86;
    const span = Math.max(0.1, (tail - lead) / Math.max(1, lines.length));
    return lines.map((text, i) => {
      const t0 = Number((lead + i * span).toFixed(2));
      const t1 = Number((lead + (i + 1) * span).toFixed(2));
      return { text, t0, t1 };
    });
  }

  on(els.btnLyrics, 'click', applyLyrics);

  // 比例膠囊
  on(els.ratioWrap, 'click', (ev) => {
    try {
      const target = ev && ev.target;
      const btn = target && typeof target.closest === 'function' ? target.closest('[data-ratio]') : null;
      if (!btn) return;
      const ratio = btn.dataset.ratio;
      if (!ratio || ratio === cfg.ratio) return;
      onChangeSafe({ ratio });
      updateRatioActive(ratio); // 立即視覺回饋，不等 main round-trip
    } catch (err) {
      console.warn('[panel] 比例切換失敗', err);
    }
  });

  // BPM（60–200）
  const pushBpm = debounce(() => {
    if (syncing || !els.bpm) return;
    const n = Math.round(Number(els.bpm.value));
    if (!Number.isFinite(n)) return;
    const v = clamp(n, 60, 200);
    if (String(v) !== String(els.bpm.value)) {
      try { els.bpm.value = String(v); } catch { /* ignore */ }
    }
    if (v === Number(cfg.bpm)) return;
    onChangeSafe({ bpm: v });
  }, 300);
  on(els.bpm, 'input', () => { if (!syncing) pushBpm(); });
  on(els.bpm, 'blur', () => { if (!syncing) pushBpm(); });

  // 主題色
  on(els.paletteWrap, 'click', (ev) => {
    try {
      const target = ev && ev.target;
      const btn = target && typeof target.closest === 'function' ? target.closest('[data-palette]') : null;
      if (!btn) return;
      const key = btn.dataset.palette;
      if (!key || key === cfg.palette) return;
      onChangeSafe({ palette: key });
      updatePaletteActive(key);
    } catch (err) {
      console.warn('[panel] 主題色切換失敗', err);
    }
  });

  // 滑桿：即時（rAF 合併）
  for (const key of RANGE_KEYS) {
    const el = byId('f-' + key);
    if (!el) continue;
    on(el, 'input', () => {
      if (syncing) return;
      const v = clamp01(el.value);
      const out = byId('v-' + key);
      if (out) out.textContent = v.toFixed(2);
      queuePatch({ [key]: v });
    });
  }

  // 場景開關
  for (const key of TOGGLE_KEYS) {
    const el = byId('f-' + key);
    if (!el) continue;
    on(el, 'change', () => {
      if (syncing) return;
      try { onChangeSafe({ [key]: !!el.checked }); } catch (err) { console.error('[panel] onChange 失敗', err); }
    });
  }

  // 時間軸拖桿
  // iOS 有時收不到 pointerup（手指離開瀏覽器範圍），所以拖動期間另外用
  // 短計時器當保險：放開 0.6 秒後就恢復「跟隨播放進度」。
  function beginSeek() {
    seeking = true;
    if (seekIdleTimer) clearTimeout(seekIdleTimer);
    seekIdleTimer = setTimeout(() => {
      seekIdleTimer = 0;
      seeking = false;
    }, 600);
  }
  on(els.seek, 'pointerdown', beginSeek);
  on(els.seek, 'change', () => { seeking = false; });
  on(window, 'pointerup', () => { seeking = false; });
  on(window, 'pointercancel', () => { seeking = false; });
  on(els.seek, 'input', () => {
    if (syncing || !els.seek) return;
    const v = Number(els.seek.value);
    if (!Number.isFinite(v)) return;
    beginSeek();
    lastSeconds = v;
    if (els.seekTime) els.seekTime.textContent = formatSafe(v);
    runAction('seek', v);
  });

  // 上傳音檔
  on(els.audioInput, 'change', () => {
    try {
      const input = els.audioInput;
      const file = input && input.files && input.files[0];
      if (!file) return;
      runAction('loadAudio', file);
      // 清 value：使用者再選同一個檔案也要能觸發 change
      try { input.value = ''; } catch { /* ignore */ }
    } catch (err) {
      console.warn('[panel] 音檔選取失敗', err);
      setStatus('無法讀取音檔：' + errText(err), 'error');
    }
  });

  // 動作按鈕
  on(els.btnPlay, 'click', () => runAction('play'));
  on(els.btnPause, 'click', () => runAction('pause'));
  on(els.btnRecord, 'click', () => {
    // 沒有音檔也要能錄（無聲影片），但一定要提示，避免使用者以為壞了
    if (!audioLoaded()) setStatus('未載入音檔 → 這次會錄成無聲影片（可先上傳音樂）', 'warn');
    runAction('record');
  });
  on(els.btnStop, 'click', () => runAction('stopRecord'));
  on(els.btnSnap, 'click', () => runAction('snapshot'));
  on(els.btnReset, 'click', () => runAction('reset'));

  // ───────────────────────── 開合（手機抽屜） ─────────────────────────

  function setOpen(open) {
    try {
      const isOpen = !!open;
      panel.classList.toggle('open', isOpen);
      if (els.toggle) {
        els.toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        // 面板打開時隱藏齒輪（它會壓在面板內容上）；收起時恢復
        els.toggle.classList.toggle('is-hidden', isOpen);
        els.toggle.textContent = isOpen ? '✕' : '⚙︎';
      }
    } catch (err) {
      console.warn('[panel] 面板開合失敗', err);
    }
  }

  function setOpenSafe(open) {
    try { setOpen(open); } catch { /* ignore */ }
  }

  on(els.toggle, 'click', () => setOpenSafe(!panel.classList.contains('open')));
  on(els.head, 'click', () => { if (isMobileViewport()) setOpenSafe(!panel.classList.contains('open')); });
  on(els.grab, 'click', () => { if (isMobileViewport()) setOpenSafe(!panel.classList.contains('open')); });
  on(els.head, 'keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && isMobileViewport()) {
      ev.preventDefault();
      setOpenSafe(!panel.classList.contains('open'));
    }
  });
  on(els.closeBtn, 'click', (ev) => {
    try { ev.stopPropagation(); } catch { /* ignore */ }
    setOpenSafe(false);
  });

  setOpenSafe(false); // 手機預設收起；桌面上這個 class 不影響佈局

  // ───────────────────────── 對外 API ─────────────────────────

  function setStatus(text, kind) {
    try {
      if (!els.status) return;
      const msg = text == null ? '' : String(text);
      if (els.status.textContent !== msg) els.status.textContent = msg;
      els.status.dataset.kind = kind || 'info';
    } catch (_err) {
      // 狀態列更新失敗不能影響主流程
    }
  }

  function setRecording(value) {
    const wasRecording = recording;
    recording = !!value;
    try {
      panel.classList.toggle('is-rec', recording);
      // 錄影中鎖住會誤觸的按鈕（停止紐反過來解鎖）
      const lockEls = panel.querySelectorAll('[data-lock]');
      for (const el of lockEls) {
        try { el.disabled = recording; } catch { /* ignore */ }
      }
      if (els.btnStop) {
        try { els.btnStop.disabled = !recording; } catch { /* ignore */ }
      }
      if (els.btnRecord) {
        els.btnRecord.textContent = recording ? '● 錄製中…' : '● 錄製成片';
      }
      if (els.audioInput) {
        try { els.audioInput.disabled = recording; } catch { /* ignore */ }
      }
      // 錄影中不要讓使用者拖時間軸：main.js 的錄影時間是 wall clock，
      // 中途 seek 會讓畫面與音樂不同步。
      if (els.seek) {
        try { els.seek.disabled = recording; } catch { /* ignore */ }
      }
      // 手機錄影時自動收起抽屜，讓使用者看得到畫面；
      // 錄完再打開，讓使用者看到「完成！已儲存 …」的狀態訊息。
      if (recording && isMobileViewport()) {
        setOpenSafe(false);
      } else if (!recording && wasRecording && isMobileViewport()) {
        setOpenSafe(true);
      }
    } catch (err) {
      console.warn('[panel] setRecording 失敗', err);
    }
  }

  function setProgress(ratio, seconds) {
    // 這個函式「每幀」被呼叫：只改 style/text，不碰 DOM 結構、不寫 innerHTML
    try {
      const r = clamp01(ratio);
      const sec = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
      lastSeconds = sec;

      if (els.progFill && Math.abs(r - lastProgress) > 0.002) {
        els.progFill.style.width = (r * 100).toFixed(1) + '%';
        lastProgress = r;
      }

      const text = formatSafe(sec) + ' / ' + formatSafe(duration());
      if (els.progTime && text !== lastTimeText) {
        els.progTime.textContent = text;
        lastTimeText = text;
      }

      // 時間軸跟著播放進度跑；使用者拖拉時不要搶
      if (!seeking && els.seek) {
        const v = String(Math.round(sec * 10) / 10);
        if (els.seek.value !== v) {
          try { els.seek.value = v; } catch { /* ignore */ }
        }
      }
    } catch (_err) {
      // 每幀路徑：任何錯誤都吞掉，不能拖垮 requestAnimationFrame
    }
  }

  function dispose() {
    try { if (patchRaf) cancelAnimationFrame(patchRaf); } catch { /* ignore */ }
    patchRaf = 0;
    try { if (seekIdleTimer) clearTimeout(seekIdleTimer); } catch { /* ignore */ }
    seekIdleTimer = 0;
    try { if (ac) ac.abort(); } catch { /* ignore */ }
    try { panel.innerHTML = ''; } catch { /* ignore */ }
    try {
      panel.classList.remove('open', 'is-rec');
      if (els.toggle) {
        els.toggle.classList.remove('is-hidden');
        els.toggle.textContent = '⚙︎';
        els.toggle.setAttribute('aria-expanded', 'false');
      }
    } catch { /* ignore */ }
  }

  refresh(cfg);

  return { refresh, setStatus, setRecording, setProgress, dispose };
}
