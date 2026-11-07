// rap-mv/test/beat.test.mjs — src/lib/beat.js 的單元測試
// 執行：node --test test/
//
// 測試用的音訊全部是「確定性合成」的：每 X 秒一個低頻 kick（正弦 + 指數衰減），
// 外加少量 LCG 雜訊，所以不需要任何音檔、每次跑結果都一樣。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBpm, createTracker, syntheticStats } from '../src/lib/beat.js';

// ── 合成測試訊號：固定 BPM 的低頻 kick 軌 ─────────────────────────
function makeKickTrack({ bpm, seconds = 20, sampleRate = 44100, noise = 0.01, seed = 1 }) {
  const n = Math.round(seconds * sampleRate);
  const data = new Float32Array(n);

  // 自己寫的 LCG，避免 Math.random 讓測試不可重現
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };

  const period = 60 / bpm;
  const kickLen = Math.floor(0.13 * sampleRate);
  for (let beat = 0; ; beat++) {
    const i0 = Math.round(beat * period * sampleRate);
    if (i0 >= n) break;
    for (let k = 0; k < kickLen && i0 + k < n; k++) {
      const tk = k / sampleRate;
      const env = Math.exp(-tk / 0.035);
      // 60Hz + 55Hz 低頻正弦，模擬 kick / 808
      data[i0 + k] += 0.8 * env * (Math.sin(2 * Math.PI * 60 * tk) + 0.3 * Math.sin(2 * Math.PI * 55 * tk));
    }
  }
  if (noise > 0) {
    for (let i = 0; i < n; i++) data[i] += noise * rand();
  }
  return data;
}

// ── analyzeBpm ──────────────────────────────────────────────────
test('analyzeBpm：120 BPM / 44.1kHz / 20 秒（含雜訊）誤差 ≤ 3 BPM', () => {
  const sr = 44100;
  const data = makeKickTrack({ bpm: 120, seconds: 20, sampleRate: sr, noise: 0.01 });

  const t0 = performance.now();
  const r = analyzeBpm(data, sr);
  const ms = performance.now() - t0;

  assert.equal(typeof r.bpm, 'number');
  assert.ok(Math.abs(r.bpm - 120) <= 3, `bpm 應接近 120，實際 ${r.bpm}`);
  assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence 應在 0..1，實際 ${r.confidence}`);

  // beats：20 秒 120 BPM → 約 40 拍
  assert.ok(Array.isArray(r.beats), 'beats 應為陣列');
  assert.ok(r.beats.length >= 35 && r.beats.length <= 45, `beats 數量 ${r.beats.length}`);
  for (let i = 1; i < r.beats.length; i++) {
    assert.ok(r.beats[i] > r.beats[i - 1], 'beats 必須嚴格遞增');
  }
  assert.ok(r.beats[0] >= 0 && r.beats[0] <= 1, `第一個 beat 應在 0..1 秒，實際 ${r.beats[0]}`);
  assert.ok(r.beats[r.beats.length - 1] <= 20, 'beats 不應超出音檔長度');

  // 效能硬性要求：20 秒音檔 < 1 秒
  assert.ok(ms < 1000, `20 秒音檔分析耗時 ${ms.toFixed(0)}ms，應小於 1000ms`);
});

test('analyzeBpm：92 BPM / 48kHz / 20 秒（含雜訊）誤差 ≤ 3 BPM', () => {
  const sr = 48000;
  const data = makeKickTrack({ bpm: 92, seconds: 20, sampleRate: sr, noise: 0.012 });

  const t0 = performance.now();
  const r = analyzeBpm(data, sr);
  const ms = performance.now() - t0;

  assert.ok(Math.abs(r.bpm - 92) <= 3, `bpm 應接近 92，實際 ${r.bpm}`);
  assert.ok(r.beats.length >= 25 && r.beats.length <= 35, `beats 數量 ${r.beats.length}`);
  assert.ok(ms < 1000, `分析耗時 ${ms.toFixed(0)}ms 應 < 1000ms`);
});

test('analyzeBpm：靜音回 bpm 0（或信心極低）且不抛錯', () => {
  const silence = new Float32Array(44100 * 20);
  let r;
  assert.doesNotThrow(() => {
    r = analyzeBpm(silence, 44100);
  });
  assert.ok(r.bpm === 0 || r.confidence < 0.1, `靜音應回 bpm 0 或低信心，實際 bpm=${r.bpm} conf=${r.confidence}`);
  assert.ok(Array.isArray(r.beats));
});

test('analyzeBpm：純噪音不抛錯、數值合法', () => {
  let s = 7;
  const noise = new Float32Array(44100 * 5);
  for (let i = 0; i < noise.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    noise[i] = (s / 4294967296) * 2 - 1;
  }
  let r;
  assert.doesNotThrow(() => {
    r = analyzeBpm(noise, 44100);
  });
  assert.ok(r.bpm >= 0 && r.bpm <= 200, `bpm 應在 0..200，實際 ${r.bpm}`);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  assert.ok(Array.isArray(r.beats));
});

test('analyzeBpm：極短 / 空輸入不抛錯', () => {
  for (const bad of [null, undefined, new Float32Array(0), new Float32Array(10), []]) {
    let r;
    assert.doesNotThrow(() => {
      r = analyzeBpm(bad, 44100);
    });
    assert.equal(r.bpm, 0);
    assert.deepEqual(r.beats, []);
  }
  // 不合理的 sampleRate 也要能活著
  const silent = new Float32Array(100);
  assert.doesNotThrow(() => analyzeBpm(silent, NaN));
});

// ── createTracker ───────────────────────────────────────────────
test('createTracker：能量上升時 beat 曾 > 0.5，beatIndex 遞增', () => {
  const tracker = createTracker(44100, 120);
  let maxBeat = 0;
  let lastIndex = 0;
  let seenLoud = 0;

  // 每 8 次 push 一次高能量，製造「重拍」上升沿
  for (let i = 0; i < 64; i++) {
    const energy = 0.15 + 0.7 * ((i % 8) / 8);
    const out = tracker.push({ rms: energy, bass: energy * 0.8, mid: 0.4, treble: 0.3, now: i / 60 });
    maxBeat = Math.max(maxBeat, out.beat);
    assert.ok(out.beatIndex >= lastIndex, 'beatIndex 不可倒退');
    lastIndex = out.beatIndex;
    if (out.beat > 0.5) seenLoud++;
    assert.ok(Number.isInteger(out.beatIndex) && out.beatIndex >= 0);
  }

  assert.ok(maxBeat > 0.5, `beat 峰值應 > 0.5，實際 ${maxBeat}`);
  assert.ok(seenLoud >= 5, `應多次出現 beat > 0.5，實際 ${seenLoud} 次`);
  assert.ok(lastIndex >= 2, `beatIndex 應有意義地遞增，實際 ${lastIndex}`);
});

test('createTracker：沒有能量上升時 beat 單調遞減', () => {
  const tracker = createTracker(44100, 0); // bpm=0 → 關掉格線，只測衰減
  let out;
  // 先用上升沿把包絡打到高點
  for (let i = 0; i < 3; i++) {
    out = tracker.push({ rms: 0.9, bass: 0.9, mid: 0.5, treble: 0.4, now: i / 60 });
  }
  assert.ok(out.beat > 0.5, `觸發後 beat 應 > 0.5，實際 ${out.beat}`);

  // 之後能量完全持平 → 不應再觸發，beat 只能衰減
  const beats = [];
  let now = 3 / 60;
  for (let i = 0; i < 30; i++) {
    now += 1 / 60;
    out = tracker.push({ rms: 0.9, bass: 0.9, mid: 0.5, treble: 0.4, now });
    beats.push(out.beat);
  }
  for (let i = 1; i < beats.length; i++) {
    assert.ok(beats[i] <= beats[i - 1] + 1e-9, `第 ${i} 次 push beat 未單調遞減：${beats[i - 1]} → ${beats[i]}`);
  }
  assert.ok(beats[beats.length - 1] < beats[0] * 0.5, '30 幀後 beat 應明顯衰減');
});

test('createTracker：所有連續輸出都夾在 0..1（含超界輸入）', () => {
  const tracker = createTracker(44100, 100);
  const inputs = [
    { rms: 5, bass: -3, mid: 2, treble: 0.5 },
    { rms: -1, bass: 4, mid: -2, treble: 9 },
    { rms: 0.5, bass: 0.5, mid: 0.5, treble: 0.5 },
    { rms: NaN, bass: undefined, mid: null, treble: Infinity },
  ];
  for (let i = 0; i < 40; i++) {
    const src = inputs[i % inputs.length];
    const out = tracker.push({ ...src, now: i / 60 });
    for (const key of ['rms', 'bass', 'mid', 'treble', 'beat']) {
      assert.ok(out[key] >= 0 && out[key] <= 1, `${key} 應在 0..1，實際 ${out[key]}`);
    }
    assert.ok(Number.isInteger(out.beatIndex) && out.beatIndex >= 0);
  }
});

test('createTracker：bpm 未提供時仍可用能量上升偵測', () => {
  const tracker = createTracker(48000); // bpm undefined
  let maxBeat = 0;
  for (let i = 0; i < 40; i++) {
    const energy = i % 8 === 0 ? 0.85 : 0.15;
    const out = tracker.push({ rms: energy, bass: energy, mid: 0.3, treble: 0.2, now: i / 60 });
    maxBeat = Math.max(maxBeat, out.beat);
  }
  assert.ok(maxBeat > 0.5, `即使沒有 BPM 也應該偵測到重拍，實際峰值 ${maxBeat}`);
});

test('createTracker：reset 會清空包絡與計數', () => {
  const tracker = createTracker(44100, 120);
  let out;
  for (let i = 0; i < 30; i++) {
    out = tracker.push({ rms: 0.8, bass: 0.8, mid: 0.4, treble: 0.3, now: i / 60 });
  }
  assert.ok(out.beatIndex > 0);
  tracker.reset();
  out = tracker.push({ rms: 0, bass: 0, mid: 0, treble: 0, now: 10 });
  assert.equal(out.beat, 0);
  assert.equal(out.beatIndex, 0);
  assert.equal(out.rms, 0);
});

// ── syntheticStats ──────────────────────────────────────────────
test('syntheticStats：Stats 欄位齊全、值域 0..1', () => {
  const duration = 20;
  for (let i = 0; i <= 400; i++) {
    const t = (i / 400) * duration;
    const s = syntheticStats(t, 92, duration);
    assert.equal(s.hasAudio, false);
    assert.equal(s.playing, false);
    assert.equal(s.bpm, 92);
    assert.ok(Math.abs(s.t - t) < 1e-9);
    for (const key of ['rms', 'bass', 'mid', 'treble', 'beat']) {
      assert.ok(Number.isFinite(s[key]) && s[key] >= 0 && s[key] <= 1, `${key} 在 t=${t} 超界：${s[key]}`);
    }
    assert.ok(Number.isInteger(s.beatIndex) && s.beatIndex >= 0);
  }
});

test('syntheticStats：beat 有明顯脈衝，段落有起伏', () => {
  const duration = 20;
  const beatSamples = [];
  let rmsIntro = 0;
  let rmsHook = 0;
  let nIntro = 0;
  let nHook = 0;

  for (let i = 0; i <= 2000; i++) {
    const t = (i / 2000) * duration;
    const s = syntheticStats(t, 92, duration);
    beatSamples.push(s.beat);
    if (t >= 0.5 && t < 1.5) { rmsIntro += s.rms; nIntro++; }
    if (t >= 11 && t < 15) { rmsHook += s.rms; nHook++; }
  }
  const maxBeat = Math.max(...beatSamples);
  const minBeat = Math.min(...beatSamples);
  const loudCount = beatSamples.filter((b) => b > 0.5).length;

  assert.ok(maxBeat > 0.8, `beat 峰值應 > 0.8，實際 ${maxBeat}`);
  assert.ok(minBeat < 0.15, `beat 谷值應 < 0.15，實際 ${minBeat}`);
  assert.ok(loudCount >= 10, `beat > 0.5 的取樣點應夠多，實際 ${loudCount}`);

  // 前奏（0.5–1.5s）應比副歌（11–15s）弱
  assert.ok(rmsHook / nHook > (rmsIntro / nIntro) * 1.25, '副歌應該比前奏強');
});

test('syntheticStats：同 t 同結果（確定性）且 bpm 省略時有備援值', () => {
  for (const t of [0, 1.234, 7.77, 16.2, 19.99]) {
    const a = syntheticStats(t, 92, 20);
    const b = syntheticStats(t, 92, 20);
    assert.deepEqual(a, b);
  }
  const noBpm = syntheticStats(3.3, 0, 20);
  assert.ok(noBpm.bpm > 0, 'bpm=0 時應使用內部備援 BPM');
  assert.ok(noBpm.beat >= 0 && noBpm.beat <= 1);
  // t 超出範圍會夾回 0..duration，不丢 NaN
  const over = syntheticStats(999, 92, 20);
  assert.equal(over.t, 20);
  assert.ok(over.rms >= 0 && over.rms <= 1);
});
