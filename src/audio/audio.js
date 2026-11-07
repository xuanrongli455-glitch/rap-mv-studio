// rap-mv/src/audio/audio.js — WebAudio 播放引擎 + 頻譜分析 + 錄影混音來源
//
// 為什麼這樣設計（給後續維護的人）：
// 1) iOS Safari 規定 AudioContext 必須在使用者手勢中「建立 / resume」，
//    所以 createAudio() 本身完全不碰 AudioContext —— 全部延後到 ensureContext()，
//    由 main.js 在「按試看 / 按錄製 / 選音檔」這些手勢路徑裡呼叫。
// 2) 播放鏈：source → gain ─┬→ analyser → ctx.destination（喇叭，聽得到的）
//                            └→ MediaStreamAudioDestinationNode（MediaRecorder 錄音用）
//    兩路都從同一顆 GainNode 分接，錄出來的音量與使用者聽到的一致。
// 3) getStats() 每幀被呼叫（60fps），所以所有 TypedArray 一律重用，
//    絕對不要在裡面 new 陣列，否則 iOS 上會 GC 抖動、掉幀。
// 4) 這個模組不 import three —— 音訊不需要 3D，避免拖慢模組載入。

import { analyzeBpm, createTracker, syntheticStats } from '../lib/beat.js';

const DEFAULT_BPM = 92;
const MIN_BPM = 60;
const MAX_BPM = 200;
const FFT_SIZE = 2048;

// 音樂的 float32 樣本 RMS 大約落在 0.1~0.35，乘上這個係數才對得上視覺要的 0..1 強度。
const RMS_GAIN = 3.2;

// BPM 只分析前 45 秒：對 3~6 分鐘的歌已經足夠準，
// 又避免在 iPhone 主執行緒上一次處理幾千萬個樣本而卡住 UI。
const ANALYZE_SECONDS = 45;
const ANALYZE_RATE = 22050; // 先降到 ~22k 再丟給 analyzeBpm，運算量少一半以上

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const fin = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp01(n) : fallback;
};

export async function createAudio() {
  /** @type {AudioContext|null} */ let ctx = null;
  /** @type {AudioBuffer|null} */ let buffer = null;
  /** @type {AudioBufferSourceNode|null} */ let source = null;
  /** @type {GainNode|null} */ let gain = null;
  /** @type {AnalyserNode|null} */ let analyser = null;
  /** @type {MediaStreamAudioDestinationNode|null} */ let mediaDest = null;
  /** @type {MediaStream|null} */ let stream = null;

  // 播放位置的兩個時間點：offset（歌曲秒數）+ startedAt（ctx.currentTime）
  // 目前歌曲時間 = offset + (ctx.currentTime - startedAt)
  let offset = 0;
  let startedAt = 0;
  let playing = false;

  // BPM：detectedBpm 是「自動偵測」的結果（可能 null），bpm 是實際採用的值
  let bpm = DEFAULT_BPM;
  let detectedBpm = null;
  /** @type {{name:string, duration:number}|null} */
  let info = null;

  /** @type {ReturnType<typeof createTracker>|null} */ let tracker = null;
  let trackerBpm = -1;

  // 每幀重用，不重新配置
  /** @type {Uint8Array|null} */ let freqU8 = null;
  /** @type {Float32Array|null} */ let timeF32 = null;
  /** @type {Uint8Array|null} */ let timeU8 = null;

  // 重用同一個 Stats 物件（main.js / scene 都是讀完就用，不長期持有）
  const statsOut = {
    t: 0,
    rms: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    beat: 0,
    beatIndex: 0,
    bpm: DEFAULT_BPM,
    playing: false,
    hasAudio: false,
  };

  // ───────────────────────── 小工具 ─────────────────────────

  function ensureBuffers() {
    if (!analyser) return;
    const n = analyser.fftSize;
    if (!timeF32 || timeF32.length !== n) timeF32 = new Float32Array(n);
    if (!timeU8 || timeU8.length !== n) timeU8 = new Uint8Array(n);
    const bins = analyser.frequencyBinCount;
    if (!freqU8 || freqU8.length !== bins) freqU8 = new Uint8Array(bins);
  }

  function clampTime(t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return 0;
    const dur = buffer ? buffer.duration : 0;
    return dur > 0 ? Math.min(n, dur) : n;
  }

  function fallbackDuration() {
    // syntheticStats 需要「影片長度」來安排前奏/主歌/副歌；
    // 影片長度以 config.duration 為準（有音檔也一樣，MV 長度是 20 秒）。
    try {
      const cfg = typeof window !== 'undefined' ? window.__MV_CONFIG__ : null;
      const d = cfg && Number(cfg.duration);
      if (Number.isFinite(d) && d > 0) return d;
    } catch { /* window 不存在就算了 */ }
    if (buffer && buffer.duration > 0) return buffer.duration;
    return 20;
  }

  function killSource() {
    const node = source;
    source = null;
    if (!node) return;
    try { node.onended = null; } catch { /* 某些實作會鎖屬性 */ }
    try { node.stop(0); } catch { /* 還沒 start 或已停止 */ }
    try { node.disconnect(); } catch { /* ignore */ }
  }

  // 同步啟動一個新的 buffer source（呼叫端保證 ctx / buffer / gain 都存在）
  function startSource(fromTime) {
    if (!buffer || !ctx || !gain) return;
    let at = Number(fromTime);
    if (!Number.isFinite(at) || at < 0) at = 0;
    // 起點太靠近結尾時直接從 0 開始：start() 對超出長度的 offset 會丟 exception
    if (at >= buffer.duration - 0.02) at = 0;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);
    // 用 closure 判斷「這顆 node 是否還是現役」，避免舊 node 的 ended 事件
    // 把新一輪播放的狀態蓋掉（暫停後立刻播放時很容易發生）。
    node.onended = () => {
      if (node !== source) return;
      source = null;
      playing = false;
      offset = buffer ? buffer.duration : 0;
    };

    try {
      node.start(0, at);
      source = node;
      offset = at;
      startedAt = ctx.currentTime;
      playing = true;
    } catch (err) {
      console.warn('[audio] 無法開始播放', err);
      try { node.disconnect(); } catch { /* ignore */ }
      playing = false;
    }
  }

  function getTracker() {
    const rate = (ctx && ctx.sampleRate) || 44100;
    const want = bpm || DEFAULT_BPM;
    if (!tracker || trackerBpm !== want) {
      tracker = null;
      trackerBpm = want;
      try {
        tracker = createTracker(rate, want);
      } catch (err) {
        console.warn('[audio] createTracker 失敗，beat 改用簡易包絡', err);
        tracker = null;
      }
    }
    return tracker;
  }

  // 把即時能量餵給 lib/beat.js 的 tracker；失敗時退回「BPM 格線 + 線性衰減」。
  function trackTo(rms, bass, mid, treble, now) {
    const t = getTracker();
    if (t && typeof t.push === 'function') {
      try {
        const out = t.push({ rms, bass, mid, treble, now });
        if (out && Number.isFinite(Number(out.beat))) return out;
      } catch (err) {
        console.warn('[audio] tracker.push 失敗', err);
      }
    }
    // fallback：以 BPM 格線產生每次重拍後衰減的包絡（無瞬態偵測，但至少會動）
    const spb = 60 / Math.max(40, bpm || DEFAULT_BPM);
    const phase = now / spb;
    const beat = Math.max(0, 1 - (phase - Math.floor(phase)) * 2.6);
    return { rms, bass, mid, treble, beat, beatIndex: Math.floor(phase) };
  }

  function fillIdleStats(t) {
    // 沒有音檔、或音檔還沒播放：用 lib/beat.js 的合成節拍，
    // 讓使用者還沒上傳音樂時也能看到節奏動態（也給錄無聲影片用）。
    let s = null;
    try {
      s = syntheticStats(t, bpm || DEFAULT_BPM, fallbackDuration());
    } catch (err) {
      s = null;
    }
    statsOut.t = t;
    if (s && typeof s === 'object') {
      statsOut.rms = fin(s.rms);
      statsOut.bass = fin(s.bass);
      statsOut.mid = fin(s.mid);
      statsOut.treble = fin(s.treble);
      statsOut.beat = fin(s.beat);
      const bi = Number(s.beatIndex);
      statsOut.beatIndex = Number.isFinite(bi) ? bi : 0;
    } else {
      // 最終保險：連合成節拍都失敗，也要回傳合法 Stats，主迴圈不能因此死掉
      statsOut.rms = 0;
      statsOut.bass = 0;
      statsOut.mid = 0;
      statsOut.treble = 0;
      statsOut.beat = 0;
      statsOut.beatIndex = 0;
    }
    statsOut.bpm = bpm || DEFAULT_BPM;
    statsOut.playing = false;
    statsOut.hasAudio = !!buffer;
    return statsOut;
  }

  // ───────────────────────── AudioContext ─────────────────────────

  async function ensureContext() {
    if (!ctx) {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) throw new Error('這個瀏覽器不支援 Web Audio');
      // 帶 latencyHint 建立；少數舊 WebKit 不認這個 option，降級成無參數版本。
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch (err) {
        console.warn('[audio] AudioContext 不支援 latencyHint，改用預設值', err);
        ctx = new AC();
      }

      // 播放鏈
      gain = ctx.createGain();
      gain.gain.value = 1;

      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.72;

      gain.connect(analyser);
      analyser.connect(ctx.destination);

      // 錄影混音：從同一顆 gain 分接到 MediaStreamAudioDestinationNode。
      // iOS Safari 14.1+ 支援；萬一沒有就錄無聲影片，不能讓它擋住錄影。
      try {
        if (typeof ctx.createMediaStreamDestination === 'function') {
          mediaDest = ctx.createMediaStreamDestination();
          gain.connect(mediaDest);
          stream = mediaDest.stream;
        }
      } catch (err) {
        console.warn('[audio] 無法建立錄影用音訊串流，錄影會是無聲', err);
        mediaDest = null;
        stream = null;
      }

      ensureBuffers();
    }

    // iOS 一定要在使用者手勢中 resume；重複呼叫是安全的。
    try {
      if (ctx.state !== 'running' && typeof ctx.resume === 'function') await ctx.resume();
    } catch (err) {
      console.warn('[audio] AudioContext resume 失敗（可能不是手勢觸發）', err);
    }

    ensureBuffers();
    return ctx;
  }

  // ───────────────────────── 解碼 / BPM ─────────────────────────

  function decodeBuffer(arrayBuffer) {
    // 同時接 Promise 與 callback 兩種 API：iOS 舊版只吃 callback，
    // 新版 Safari/Chrome 回傳 Promise。用 settled 避免重複 resolve。
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      try {
        const maybe = ctx.decodeAudioData(arrayBuffer, ok, fail);
        if (maybe && typeof maybe.then === 'function') maybe.then(ok, fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  function detectBpm(decoded) {
    try {
      const srcRate = decoded.sampleRate || 44100;
      const nch = decoded.numberOfChannels || 0;
      if (!nch) return null;

      const channels = [];
      for (let c = 0; c < nch; c++) channels.push(decoded.getChannelData(c));

      // 1) 只取前 45 秒；2) 用整數 step 做簡單降採樣（取平均，順便混左右聲道）
      const step = Math.max(1, Math.round(srcRate / ANALYZE_RATE));
      const secs = Math.min(decoded.duration || 0, ANALYZE_SECONDS);
      const frames = Math.floor((secs * srcRate) / step);
      if (frames < 2048) return null;

      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const base = i * step;
        let acc = 0;
        for (let c = 0; c < nch; c++) {
          const data = channels[c];
          const end = Math.min(base + step, data.length);
          for (let k = base; k < end; k++) acc += data[k];
        }
        mono[i] = acc / (nch * step);
      }

      const res = analyzeBpm(mono, srcRate / step);
      const raw = res && Number(res.bpm);
      // 邊界用「容差」判斷：分析器會回 59.95、200.04 這種值，
      // 用嚴格 < / > 會把真正 60 BPM 或 200 BPM 的歌丟成「偵測不到」。
      if (!Number.isFinite(raw) || raw <= 0) return null;
      if (raw < MIN_BPM - 3 || raw > MAX_BPM + 3) return null;
      const v = Math.min(MAX_BPM, Math.max(MIN_BPM, raw));
      return Math.round(v * 10) / 10;
    } catch (err) {
      console.warn('[audio] BPM 偵測失敗，回報 null 讓使用者手動填', err);
      return null;
    }
  }

  // ───────────────────────── 對外 API ─────────────────────────

  async function loadFile(file) {
    if (!file) throw new Error('沒有選擇音檔');
    await ensureContext();
    stop(); // 換歌時先把舊的停掉，避免分析期間舊歌還在響

    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (err) {
      throw new Error('讀不到音檔內容：' + (err && err.message ? err.message : err));
    }

    let decoded;
    try {
      decoded = await decodeBuffer(arrayBuffer);
    } catch (err) {
      throw new Error('無法解碼這個音訊檔（建議 mp3 / m4a / wav）：' + (err && err.message ? err.message : err));
    }

    buffer = decoded;
    info = { name: file.name || 'audio', duration: decoded.duration };
    detectedBpm = detectBpm(decoded);
    if (detectedBpm) bpm = detectedBpm;
    offset = 0;
    playing = false;
    tracker = null;
    trackerBpm = -1;
    try { getTracker(); } catch { /* 已在上層處理 */ }

    return { name: info.name, duration: info.duration, bpm: detectedBpm };
  }

  async function play(fromTime = 0) {
    await ensureContext();
    if (!buffer) {
      // 沒有音檔：main.js 會用合成節拍跑試看，這裡只要確保狀態正確。
      playing = false;
      return;
    }
    killSource();
    playing = false;
    if (tracker && typeof tracker.reset === 'function') {
      try { tracker.reset(); } catch { /* ignore */ }
    }
    startSource(fromTime);
  }

  function pause() {
    if (playing) offset = getTime();
    playing = false;
    killSource();
    if (Number.isFinite(offset)) offset = clampTime(offset);
  }

  function stop() {
    playing = false;
    offset = 0;
    killSource();
  }

  function seek(t) {
    if (!buffer) { offset = 0; return; }
    const target = clampTime(t);
    if (playing) {
      killSource();
      startSource(target);
    } else {
      offset = target;
    }
  }

  function getTime() {
    if (!buffer) return 0;
    if (playing && ctx) {
      return Math.max(0, Math.min(buffer.duration, offset + (ctx.currentTime - startedAt)));
    }
    return Math.max(0, Math.min(buffer.duration, offset));
  }

  function getStats(tFallback) {
    const t = Number.isFinite(Number(tFallback)) ? Number(tFallback) : getTime();

    // 沒有音檔 / 沒在播放 → 合成節拍（比全 0 好看，也讓無聲錄影有動態）
    if (!buffer || !analyser || !ctx || !playing) return fillIdleStats(t);

    ensureBuffers();

    // 1) 時域 RMS（用 getFloatTimeDomainData；舊裝置退回 byte 版本）
    let rmsRaw = 0;
    try {
      if (typeof analyser.getFloatTimeDomainData === 'function' && timeF32) {
        analyser.getFloatTimeDomainData(timeF32);
        let sum = 0;
        for (let i = 0; i < timeF32.length; i++) {
          const v = timeF32[i];
          sum += v * v;
        }
        rmsRaw = Math.sqrt(sum / timeF32.length);
      } else if (timeU8) {
        analyser.getByteTimeDomainData(timeU8);
        let sum = 0;
        for (let i = 0; i < timeU8.length; i++) {
          const v = (timeU8[i] - 128) / 128;
          sum += v * v;
        }
        rmsRaw = Math.sqrt(sum / timeU8.length);
      }
    } catch (err) {
      // analyser 在 context 被關閉後會丟錯，這裡吞掉即可
    }

    // 2) 頻域分頻：bass 20–250Hz、mid 250–4kHz、treble 4k–16kHz
    let bass = 0;
    let mid = 0;
    let treble = 0;
    try {
      analyser.getByteFrequencyData(freqU8);
      const binHz = ctx.sampleRate / analyser.fftSize;
      bass = clamp01(bandAverage(freqU8, 20, 250, binHz) * 1.35);
      mid = clamp01(bandAverage(freqU8, 250, 4000, binHz) * 1.25);
      treble = clamp01(bandAverage(freqU8, 4000, 16000, binHz) * 1.5);
    } catch (err) {
      // 同上，壞掉就維持 0，不影響主迴圈
    }

    const rms = clamp01(rmsRaw * RMS_GAIN);
    const tracked = trackTo(rms, bass, mid, treble, ctx.currentTime);

    statsOut.t = t;
    statsOut.rms = fin(tracked.rms, rms);
    statsOut.bass = fin(tracked.bass, bass);
    statsOut.mid = fin(tracked.mid, mid);
    statsOut.treble = fin(tracked.treble, treble);
    statsOut.beat = fin(tracked.beat);
    const bi = Number(tracked.beatIndex);
    statsOut.beatIndex = Number.isFinite(bi) ? bi : 0;
    statsOut.bpm = bpm || DEFAULT_BPM;
    statsOut.playing = true;
    statsOut.hasAudio = true;
    return statsOut;
  }

  function setBpm(next) {
    const n = Number(next);
    if (!Number.isFinite(n)) return;
    const v = Math.min(MAX_BPM, Math.max(MIN_BPM, n));
    if (v === bpm) return;
    bpm = v;
    tracker = null; // 讓 tracker 用新的 BPM 重建重拍格線
    trackerBpm = -1;
  }

  function getBpm() {
    return bpm;
  }

  // 額外 API（合約沒列，但 UI 顯示「自動偵測」與音檔資訊需要）
  function getDetectedBpm() {
    return detectedBpm;
  }

  function getInfo() {
    if (!info) return null;
    return { name: info.name, duration: info.duration, bpm: detectedBpm };
  }

  function isLoaded() {
    return !!buffer;
  }

  function getStream() {
    // 沒音檔就不提供音軌 → MediaRecorder 只錄畫面，輸出無聲影片
    return buffer ? stream : null;
  }

  async function dispose() {
    try { stop(); } catch { /* ignore */ }
    tracker = null;
    trackerBpm = -1;
    if (mediaDest) {
      try { mediaDest.disconnect(); } catch { /* ignore */ }
      mediaDest = null;
    }
    stream = null;
    if (gain) { try { gain.disconnect(); } catch { /* ignore */ } }
    if (analyser) { try { analyser.disconnect(); } catch { /* ignore */ } }
    gain = null;
    analyser = null;
    freqU8 = null;
    timeF32 = null;
    timeU8 = null;
    buffer = null;
    info = null;
    const old = ctx;
    ctx = null;
    if (old) {
      try { await old.close(); } catch { /* ignore */ }
    }
  }

  // 供頻譜用：把某個 Hz 區間的平均值正規化成 0..1（data 是 0..255 的 byte）
  function bandAverage(data, loHz, hiHz, binHz) {
    const n = data ? data.length : 0;
    if (!n) return 0;
    const hz = binHz > 0 ? binHz : 1;
    let lo = Math.floor(loHz / hz);
    let hi = Math.ceil(hiHz / hz);
    if (lo < 0) lo = 0;
    if (hi > n - 1) hi = n - 1;
    if (hi < lo) return 0;
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += data[i];
    return sum / ((hi - lo + 1) * 255);
  }

  return {
    loadFile,
    ensureContext,
    play,
    pause,
    stop,
    seek,
    setBpm,
    getBpm,
    getDetectedBpm,
    getInfo,
    isLoaded,
    getTime,
    getStats,
    getStream,
    dispose,
  };
}
