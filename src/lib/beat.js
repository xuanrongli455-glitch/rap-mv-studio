// rap-mv/src/lib/beat.js — 節拍分析 / 節拍包絡追蹤 / 無音檔合成節拍
//
// 這一支是「純函式庫」：不碰 DOM / window / AudioContext / three，
// 在 import 時不做任何事（沒有頂層副作用），所以可以直接在 node 裡測。
//
// 對外 API（合約見 src/contract.md E 段）：
//   analyzeBpm(channelData, sampleRate, opts?)  → { bpm, confidence, beats: number[] }
//   createTracker(sampleRate, bpm)              → { push(input): Stats部分, reset() }
//   syntheticStats(t, bpm, duration)            → 完整 Stats（無音檔時的假節拍）
//   cacheBypassNorm(...)                        → 合約預留的自由實作（小工具）
//
// ── analyzeBpm 的做法（避免 O(n²)）─────────────────────────────
//   1. box filter 降採樣到 ~22050Hz（box 同時當作簡單抗鋸齒低通）
//   2. |x| → 非重疊分幀（hop 256）→ 能量包絡（每幀一個數值，20 秒約 1700 幀）
//   3. 減去局部移動平均（去趨勢）→ 半波整流，保留「瞬態上升」的形狀
//   4. 正規化自相關：lag 對應 40–200 BPM；乘上 tempo prior 壓制半速/倍速誤判
//   5. 拋物線內插細化 lag → 分數 BPM
//   6. 相位掃描 + 週期微調（以包絡能量對齊）→ beats 時間點、再度校正 BPM
//   總複雜度 O(N·L)，N≈1723、L≈103，20 秒音檔實測遠低於 1 秒。

/** 把數值夾在 0..1（NaN 視為 0、Infinity 視為 1）。 */
function clamp01(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 夾在 a..b（允許 a > b 時自動交換）。 */
function clampRange(v, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const n = Number(v);
  if (Number.isNaN(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

// ── 內部：降採樣（box filter 兼抗鋸齒低通）──────────────────────
// 回傳 Float32Array 與實際採樣率。20 秒 44.1k → 約 44 萬點降到 22 萬點。
function decimate(channelData, sampleRate, targetRate) {
  const src = channelData && channelData.length ? channelData : null;
  if (!src) return { data: new Float32Array(0), rate: sampleRate, factor: 1 };

  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  const n = Math.floor(src.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * factor;
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += src[base + j] || 0;
    out[i] = sum / factor;
  }
  return { data: out, rate: sampleRate / factor, factor };
}

// ── 內部：|x| 分幀能量包絡（非重疊 hop）──────────────────────────
function energyEnvelope(data, hop) {
  const n = Math.floor(data.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * hop;
    let sum = 0;
    for (let j = 0; j < hop; j++) sum += Math.abs(data[base + j]);
    env[i] = sum / hop;
  }
  return env;
}

// ── 內部：去趨勢（減局部移動平均）+ 半波整流 ────────────────────
// 移動平均視窗約 ±0.6 秒，剛好把「段落大小聲」拿掉、留下每一拍的瞬態。
function detrendEnvelope(env, fps, windowSec = 0.6) {
  const n = env.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const w = Math.max(4, Math.round(fps * windowSec));
  // 前綴和：O(n) 算任意視窗平均
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(n, i + w + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    const v = env[i] - mean;
    out[i] = v > 0 ? v : 0; // 半波整流：只留下「比附近大聲」的地方
  }
  return out;
}

// ── 內部：正規化自相關 r[lag]（只用前段重疊區域，O(N·L)）────────
// 有做能量正規化（Pearson 形式），所以短 lag 不會因為樣本多而虛高。
function normalizedAutocorr(env, minLag, maxLag) {
  const n = env.length;
  const r = new Float32Array(Math.max(0, maxLag + 1));
  if (n < 2) return r;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;

  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - mean;

  const lo = Math.max(1, minLag);
  const hi = Math.min(maxLag, n - 2);
  for (let lag = lo; lag <= hi; lag++) {
    const m = n - lag;
    let num = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < m; i++) {
      const a = x[i];
      const b = x[i + lag];
      num += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const den = Math.sqrt(e1 * e2);
    r[lag] = den > 1e-12 ? num / den : 0;
  }
  return r;
}

// ── 內部：tempo prior（以 120 BPM 為中心、log 尺度的高斯）────────
// 目的：當自相關在 T（真拍）與 2T（半速）都差不多高時，選接近人耳 tempo 的那個。
function tempoPrior(bpm) {
  if (!(bpm > 0)) return 0;
  const octave = Math.log2(bpm / 120);
  return Math.exp(-0.5 * (octave / 0.85) * (octave / 0.85));
}

// ── 內部：在包絡上線性內插取樣（t 單位：秒）─────────────────────
function envelopeAt(env, fps, t) {
  const p = t * fps;
  const i = Math.floor(p);
  if (i < 0 || i >= env.length - 1) {
    if (i >= 0 && i === env.length - 1) return env[i];
    return 0;
  }
  const f = p - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}

// ── 內部：固定週期 P 下，掃描相位找最貼合節拍的偏移 ─────────────
// 回傳 { score, phi }；score = 落在格點上的包絡能量總和（平均每拍）。
function bestPhase(env, fps, period, duration, steps = 160) {
  let bestScore = -1;
  let bestPhi = 0;
  // 只算完全落在訊號內的格點，避免邊界少算幾拍影響比較
  const first = 0;
  const last = Math.floor((duration - period * 0.999) / period);
  const count = Math.max(0, last - first + 1);
  if (count <= 0) return { score: 0, phi: 0 };

  for (let s = 0; s < steps; s++) {
    const phi = (s / steps) * period;
    let sum = 0;
    for (let k = first; k <= last; k++) sum += envelopeAt(env, fps, phi + k * period);
    const score = sum / count;
    if (score > bestScore) {
      bestScore = score;
      bestPhi = phi;
    }
  }
  return { score: bestScore, phi: bestPhi };
}

// ── 內部：從時間點清單估「格線相位」（供回傳值對齊用，不算分數）──
function gridBeats(phi, period, duration) {
  const beats = [];
  // 從 0 之前最近的格點開始，只保留落在 [0, duration] 內的
  let k = Math.floor((0 - phi) / period);
  let t = phi + k * period;
  while (t < 0) t += period;
  // t 可能因浮點誤差略小於 0，保險再推一次
  while (t < -1e-9) t += period;
  for (; t <= duration + 1e-9; t += period) beats.push(Math.round(t * 1e6) / 1e6);
  return beats;
}

/**
 * 估算 BPM 並找出重拍時間點。
 *
 * @param {Float32Array|number[]} channelData 單聲道樣本（-1..1，取決於來源）
 * @param {number} sampleRate 取樣率（44100 / 48000 等）
 * @param {object} [opts] { minBpm=40, maxBpm=200, targetRate=22050, hop=256 }
 * @returns {{bpm:number, confidence:number, beats:number[]}} 靜音/無法判斷時 bpm=0
 */
export function analyzeBpm(channelData, sampleRate, opts) {
  const empty = { bpm: 0, confidence: 0, beats: [] };
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
  if (!channelData || !channelData.length) return empty;

  const minBpm = clampRange(Number(opts?.minBpm) || 40, 20, 240);
  const maxBpm = clampRange(Number(opts?.maxBpm) || 200, minBpm + 1, 260);
  const targetRate = Number(opts?.targetRate) || 22050;
  const hop = Math.max(64, Math.round(Number(opts?.hop) || 256));

  // 1) 降採樣 → 能量包絡
  const dec = decimate(channelData, sr, targetRate);
  if (dec.data.length < hop * 8) return empty; // 訊號太短（<約 0.1 秒的包絡），不判斷
  const fps = dec.rate / hop; // 每秒幾個包絡幀（22050/256 ≈ 86.1）

  const envRaw = energyEnvelope(dec.data, hop);
  if (envRaw.length < 8) return empty;

  // 靜音 / 幾乎沒能量 → 直接回 0，不抛錯、不亂猜
  let peak = 0;
  let total = 0;
  for (let i = 0; i < envRaw.length; i++) {
    const v = envRaw[i];
    total += v;
    if (v > peak) peak = v;
  }
  const meanRaw = total / envRaw.length;
  if (peak < 1e-5 || meanRaw < 1e-7) return empty;

  // 2) 去趨勢 + 半波整流
  const env = detrendEnvelope(envRaw, fps, 0.6);

  // 3) 自相關：lag 換算 BPM（lag = fps * 60 / bpm）
  const lagMin = Math.max(2, Math.floor((60 / maxBpm) * fps));
  const lagMax = Math.ceil((60 / minBpm) * fps);
  if (lagMax <= lagMin || env.length < lagMax + 4) {
    return { bpm: 0, confidence: 0, beats: [] };
  }
  const r = normalizedAutocorr(env, lagMin, lagMax);

  // 4) 找加權分數峰值（乘 tempo prior 抑制半速/倍速）
  let bestLag = -1;
  let bestRaw = 0;
  let bestScore = -1;
  for (let lag = lagMin; lag < r.length; lag++) {
    const raw = r[lag];
    if (!(raw > 0)) continue;
    const score = raw * tempoPrior((60 * fps) / lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
      bestRaw = raw;
    }
  }
  if (bestLag < 0 || bestRaw < 0.05) {
    // 沒有週期性（純噪音 / 靜音）
    return { bpm: 0, confidence: clamp01(bestRaw), beats: [] };
  }

  // 5) 拋物線內插，把 lag 細化到小數 → 分數 BPM
  let refinedLag = bestLag;
  if (bestLag > lagMin && bestLag + 1 < r.length) {
    const y0 = r[bestLag - 1];
    const y1 = r[bestLag];
    const y2 = r[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (y0 - y2)) / denom;
      if (delta > -1 && delta < 1) refinedLag += delta;
    }
  }
  // lag = fps * 60 / bpm → bpm = 60 * fps / lag
  let bpm = (60 * fps) / refinedLag;

  // 6) 相位對齊 + 週期微調：用包絡能量真正「貼合」節拍，順便修正小數 BPM
  const durationSec = env.length / fps;
  const period0 = 60 / bpm;
  let best = { score: -1, phi: 0, bpm };
  // 在 ±2% 內掃週期（避免跳到倍數/半數），週期與相位一起找
  for (let k = -20; k <= 20; k++) {
    const period = period0 * (1 + k * 0.001);
    const { score, phi } = bestPhase(env, fps, period, durationSec, 96);
    if (score > best.score) best = { score, phi, bpm: 60 / period };
  }
  // 再用更細的相位網格精修一次（週期固定）
  let finalPeriod = 60 / best.bpm;
  const fine = bestPhase(env, fps, finalPeriod, durationSec, 320);
  best.phi = fine.phi; // 相位只是取最佳值，直接用精修結果
  bpm = best.bpm;

  // 6b) 八度修正：半速誤判（例如 180 / 200 BPM 被自相關判成 90 / 100）
  // 若「兩倍速」的格線也一樣貼合包絡，才代表真正的脈搏是兩倍速；
  // 真實的 90 BPM 訊號在每半拍的位置沒有能量，P/2 的貼合分數會明顯掉下來。
  // （上限給 2% 容差，否則剛好 200 BPM 的真實訊號會被邊界擋掉）
  const doubled = bpm * 2;
  if (doubled <= maxBpm * 1.02 && doubled >= minBpm) {
    const halfPeriod = finalPeriod / 2;
    const half = bestPhase(env, fps, halfPeriod, durationSec, 192);
    if (half.score >= best.score * 0.92) {
      best.phi = half.phi;
      best.score = half.score;
      finalPeriod = halfPeriod;
      bpm = 60 / finalPeriod;
    }
  }

  // 最後把 BPM 夾回合約允許的範圍（例如 200.04 → 200），beats 週期同步更新
  bpm = clampRange(bpm, minBpm, maxBpm);
  finalPeriod = 60 / bpm;

  // 信心值：自相關峰值（0..1）映射成 0..1；同時要求節拍點真的有能量
  const sharpness = clamp01((bestRaw - 0.05) / 0.65);
  const hitDensity = clamp01(best.score / Math.max(meanRaw * 2.2, 1e-9));
  const confidence = clamp01(0.75 * sharpness + 0.25 * hitDensity);

  // 信心太低（純噪音 / 沒有明顯節拍）→ 寧可回 0，讓 UI 提示使用者手動填 BPM
  if (confidence < 0.08) {
    return { bpm: 0, confidence: Math.round(confidence * 1000) / 1000, beats: [] };
  }

  const beats = gridBeats(best.phi, finalPeriod, durationSec);
  return { bpm: Math.round(bpm * 100) / 100, confidence: Math.round(confidence * 1000) / 1000, beats };
}

// ── 即時節拍追蹤器 ─────────────────────────────────────────────
// 兩條軌一起投票：
//   軌線 A（格線）：用 BPM 預測下一個重拍時間，能量有到門檻就認一個 beat。
//   軌線 B（上升沿）：能量明顯往上跳（瞬態）就認一個 beat，即使格線還沒到。
// 命中後 beat 包絡瞬間拉到 0.55 以上，之後每 1/60 秒乘 0.92 指數衰減。
/**
 * 建立即時節拍追蹤器。
 * @param {number} sampleRate 取樣率（目前只當資訊保留；節拍用秒計算）
 * @param {number} bpm 預測 BPM；0 / undefined = 不用格線，只靠能量上升
 */
export function createTracker(sampleRate, bpm) {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
  const tempo0 = Number.isFinite(bpm) && bpm > 0 ? bpm : 0;

  // 所有可變狀態都收在 closure 裡：不污染模組、可多次建立互不干擾
  const state = {
    bpm: tempo0,
    beat: 0,
    beatIndex: 0,
    lastNow: null,
    lastEnergy: 0,
    avgEnergy: 0,
    nextGrid: null, // 下一個預測重拍的「秒」時間
    rms: 0,
    bass: 0,
    mid: 0,
    treble: 0,
  };

  // 1/60 秒衰減 0.92；以 dt 換算成任意每幀都正確的衰減
  function decayFor(dt) {
    if (!(dt > 0)) return 1;
    const steps = dt * 60;
    return Math.pow(0.92, steps);
  }

  function push(input) {
    const src = input || {};
    const now =
      Number.isFinite(src.now) ? src.now : (state.lastNow == null ? 0 : state.lastNow + 1 / 60);
    const dt = state.lastNow == null ? 0 : Math.max(0, now - state.lastNow);
    state.lastNow = now;

    // 輸入特徵：一律 clamp 0..1（AnalyserNode 的實作可能給出超界值）
    const rms = clamp01(src.rms);
    const bass = clamp01(src.bass);
    const mid = clamp01(src.mid);
    const treble = clamp01(src.treble);

    // 節拍能量：低頻（kick / 808）權重高一點，說唱的重拍主要在低頻
    const energy = clamp01(rms * 0.55 + bass * 0.45);

    // 包絡先衰減（第一次 push 沒有 dt，不衰減）
    state.beat *= decayFor(dt);

    // 軌線 B：能量上升沿（相對上一次的相對門檻，底部加絕對門檻避免雜訊誤觸）
    const riseThreshold = Math.max(0.008, state.lastEnergy * 0.14);
    const rising = energy > state.lastEnergy + riseThreshold && energy > 0.05;

    // 軌線 A：BPM 預測格線
    let gridDue = false;
    if (state.bpm > 0) {
      const period = 60 / state.bpm;
      if (state.nextGrid == null) state.nextGrid = now + period * 0.5; // 先等半拍再開始預測
      // 容許提前 0.14 拍命中（瞬態通常略早於純格線）
      gridDue = now >= state.nextGrid - period * 0.14;
      // 格線嚴重過期（暫停後 seek / 大跳）→ 重新錨定，不要一直補格
      if (now - state.nextGrid > period * 2.5) {
        state.nextGrid = now;
        gridDue = true;
      }
    }
    // 格線命中也要有能量（相對最近的基準線），不然靜音會一直空響
    const gridHit =
      gridDue && energy > Math.max(0.055, state.avgEnergy * 1.25) && energy > state.lastEnergy * 0.9;

    if (rising || gridHit) {
      // 命中：包絡瞬間拉高（至少 0.55 保證「曾經 > 0.5」），並遞增 beatIndex
      state.beat = Math.min(1, 0.55 + energy * 0.9);
      state.beatIndex += 1;
      if (state.bpm > 0) {
        const period = 60 / state.bpm;
        // 以這次命中為新格線錨點；若這次是上升沿提早命中，下一拍就從現在往後推
        state.nextGrid = now + period;
      }
    } else if (state.bpm > 0 && gridDue) {
      // 格線空過（沒有能量）→ 仍然推進格線，避免無限累積
      state.nextGrid += 60 / state.bpm;
    }

    // 能量基準線：約 0.6 秒的慢速追蹤（dt 小時給定最小步進）
    const follow = dt > 0 ? Math.min(1, dt / 0.6) : 0.05;
    state.avgEnergy += (energy - state.avgEnergy) * follow;
    state.lastEnergy = energy;

    // 對外輸出的平滑特徵（以下游場景不用自己再濾一次）
    const smooth = dt > 0 ? Math.min(1, dt / 0.08) : 0.5;
    state.rms += (rms - state.rms) * smooth;
    state.bass += (bass - state.bass) * smooth;
    state.mid += (mid - state.mid) * smooth;
    state.treble += (treble - state.treble) * smooth;

    return {
      rms: clamp01(state.rms),
      bass: clamp01(state.bass),
      mid: clamp01(state.mid),
      treble: clamp01(state.treble),
      beat: clamp01(state.beat),
      beatIndex: state.beatIndex,
    };
  }

  function reset() {
    state.beat = 0;
    state.beatIndex = 0;
    state.lastNow = null;
    state.lastEnergy = 0;
    state.avgEnergy = 0;
    state.nextGrid = null;
    state.rms = 0;
    state.bass = 0;
    state.mid = 0;
    state.treble = 0;
  }

  return {
    push,
    reset,
    // 額外提供：讓 audio 模組手動改 BPM 時不用重建 tracker
    setBpm(next) {
      const v = Number(next);
      state.bpm = Number.isFinite(v) && v > 0 ? v : 0;
      state.nextGrid = null;
    },
    getBpm() {
      return state.bpm;
    },
    sampleRate: sr,
  };
}

// ── 確定性雜訊（不用 Math.random，同 t 同結果）──────────────────
function hash01(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// ── 無音檔用的合成節拍 ─────────────────────────────────────────
/**
 * 沒有上傳音檔時的假節拍 Stats：純時間函式、不配置大陣列、每幀可安全呼叫。
 * 段落起伏：前奏弱 → 主歌中 → 副歌強 → outro 收。
 * @param {number} t 影片時間（秒）
 * @param {number} bpm 節拍（0/undefined 時用 96）
 * @param {number} duration 總長（秒）
 * @returns {{t:number,rms:number,bass:number,mid:number,treble:number,beat:number,beatIndex:number,bpm:number,playing:boolean,hasAudio:boolean}}
 */
export function syntheticStats(t, bpm, duration) {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : 20;
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : 96;
  const tt = clampRange(Number.isFinite(t) ? t : 0, 0, dur);
  const period = 60 / tempo;

  // 這拍走到第幾秒 → 指數衰減包絡（0 秒 = 1，半拍後 ≈ 0.07）
  const phase = ((tt % period) + period) % period;
  const pulse = Math.exp(-phase / (period * 0.13));

  // 段落曲線：全部用平滑斜坡，避免「一整段一模一樣」的死板感
  const introEnd = Math.min(2.6, dur * 0.18);
  const outroStart = Math.max(introEnd, dur - Math.min(2, dur * 0.12));
  const hookStart = introEnd + (outroStart - introEnd) * 0.5;
  const smooth = (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x * x * (3 - 2 * x);
  };
  const toVerse = smooth((tt - (introEnd - 0.6)) / 0.6); // 前奏 → 主歌
  const toHook = smooth((tt - (hookStart - 0.55)) / 0.55); // 主歌 → 副歌
  const toOutro = smooth((tt - (outroStart - 0.5)) / 0.5); // 副歌 → 收尾
  const level = 0.26 + 0.3 * toVerse + 0.44 * toHook - 0.26 * toOutro;
  const tailFade = 1 - 0.55 * smooth((tt - (dur - 0.6)) / 0.6); // 最後淡出
  const live = clamp01(level) * tailFade;

  // 慢速起伏 + 逐步確定性雜訊（每 1/7 秒一格，讓畫面不呆板）
  const slow = 0.5 + 0.5 * Math.sin(tt * 0.9 + 1.3);
  const grain = hash01(Math.floor(tt * 7) * 1.37 + 0.5);
  const grain2 = hash01(Math.floor(tt * 5) * 2.11 + 3.7);

  const bass = clamp01(live * (0.3 + 0.65 * pulse) * (0.82 + 0.18 * slow));
  const rms = clamp01(live * (0.38 + 0.5 * pulse) * (0.86 + 0.14 * grain));
  const mid = clamp01(live * (0.24 + 0.42 * pulse) * (0.75 + 0.25 * slow) + 0.03 * grain2);
  const treble = clamp01(live * (0.14 + 0.3 * pulse) * (0.7 + 0.3 * grain2) + 0.02 * grain);

  return {
    t: tt,
    rms,
    bass,
    mid,
    treble,
    beat: clamp01(pulse),
    beatIndex: Math.max(0, Math.floor(tt / period)),
    bpm: tempo,
    playing: false,
    hasAudio: false,
  };
}

/**
 * 合約預留的自由實作：把任意數值正規化到 0..1 的小工具。
 * （名字保留給未來快取/正規化用途；目前無狀態、可安全呼叫。）
 * @param {number} value 原始值
 * @param {number} [lo=0] 下限
 * @param {number} [hi=1] 上限
 */
export function cacheBypassNorm(value, lo = 0, hi = 1) {
  const a = Number.isFinite(lo) ? lo : 0;
  const b = Number.isFinite(hi) ? hi : 1;
  const span = b - a;
  if (Math.abs(span) < 1e-12) return 0;
  return clamp01((Number(value) - a) / span);
}
