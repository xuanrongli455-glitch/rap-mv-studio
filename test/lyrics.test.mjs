// rap-mv/test/lyrics.test.mjs — 歌詞時間軸的「語意」測試（絕對秒數）與跨模組一致性
//
// 守的是這個 bug：lyricState 曾把 line.t0/t1 乘上 duration/20，
// 而 panel 的 autoDistributeLyrics 產生的是絕對秒數 → 只要片長不是 20 秒，兩邊就對不上。
// 62.76 秒的片（k=3.138）會把 8.8~54 秒的歌詞推成 27~169 秒，畫面上幾乎看不到任何一句。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lyricState } from '../src/scene/camera.js';
import { autoDistributeLyrics } from '../src/lib/timeline.js';
import { defaultConfig } from '../src/config.js';

const EPS = 1e-6;

test('lyricState：defaultConfig 每一句在自己的中點都 active、已聚合成字', () => {
  assert.ok(defaultConfig.lyrics.length > 0, 'defaultConfig 應該要有歌詞');
  for (const [i, line] of defaultConfig.lyrics.entries()) {
    const mid = (line.t0 + line.t1) / 2;
    const st = lyricState(mid, line);
    assert.ok(st.active, `第 ${i + 1} 句中點 ${mid}s 應該 active`);
    // progress 是「聚合成字」的進度：句中 p≈0.5 > 0.3 → 已飽和成 1
    assert.ok(Math.abs(st.progress - 1) < EPS, `第 ${i + 1} 句中點應已聚合成字，progress=${st.progress}`);
    assert.ok(st.opacity > 0.5, `第 ${i + 1} 句中點透明度應該夠亮，實際 ${st.opacity}`);
    assert.ok(st.burst < 0.01, `第 ${i + 1} 句中點不該已經炸散，burst=${st.burst}`);
  }
});

test('lyricState：時間是絕對秒數，不隨片長縮放（防 ×k 回歸）', () => {
  const k = defaultConfig.duration / 20;
  assert.ok(k > 2, `defaultConfig 片長要遠大於 20 秒才測得到（實際 k=${k}）`);

  const line = { text: 'x', t0: 0, t1: 5 };
  const st = lyricState(2.5, line);
  assert.ok(st.active, 't=2.5s 應落在 0..5 秒這句裡面');
  // 若哪天被乘上 k，span 會變成 15.7 秒、p 會是 0.16，
  // progress 只會到 0.545（還沒聚合成字）→ 這條立刻炸
  assert.ok(Math.abs(st.progress - 1) < EPS, `句中應已聚合成字，實際 progress=${st.progress}`);
  assert.ok(st.burst < 0.01, `句中不該炸散，實際 burst=${st.burst}`);
});

test('lyricState：句子外不 active（含句末炸散之後）', () => {
  const line = { text: 'x', t0: 7, t1: 10 };
  assert.ok(!lyricState(0, line).active, 't=0 應在句子之外');
  assert.ok(!lyricState(6, line).active, 't=6 應在句子開始之前');
  assert.ok(lyricState(8.5, line).active, 't=8.5 應在句中');
  assert.ok(!lyricState(20, line).active, 't=20 已遠離這句');
});

test('autoDistributeLyrics 的輸出直接被 lyricState 接受（兩套語意一致）', () => {
  const lines = ['第一句', '第二句', '第三句'];
  const dist = autoDistributeLyrics(lines, defaultConfig.duration);
  assert.equal(dist.length, 3);
  for (const line of dist) {
    const mid = (line.t0 + line.t1) / 2;
    assert.ok(lyricState(mid, line).active, `「${line.text}」中點 ${mid}s 應 active`);
    assert.ok(line.t1 <= defaultConfig.duration + EPS, `「${line.text}」超出片長`);
  }
  // 若 lyricState 又開始乘 k，第一句的中點會被推到很後面而失效
  assert.ok(dist[0].t0 < defaultConfig.duration * 0.25, '第一句不該被推到影片後段');
});

test('defaultConfig：歌詞都在片長內、依序且不重疊', () => {
  const D = defaultConfig.duration;
  assert.ok(D > 20, `片長應為整首歌長度，實際 ${D}`);
  let prevEnd = -Infinity;
  for (const [i, line] of defaultConfig.lyrics.entries()) {
    assert.ok(Number.isFinite(line.t0) && Number.isFinite(line.t1), `第 ${i + 1} 句時間不是數字`);
    assert.ok(line.t1 > line.t0, `第 ${i + 1} 句 t1 必須 > t0`);
    assert.ok(line.t0 >= 0, `第 ${i + 1} 句 t0 不可為負`);
    assert.ok(line.t1 <= D + EPS, `第 ${i + 1} 句結束 ${line.t1}s 超出片長 ${D}s`);
    assert.ok(line.t0 >= prevEnd - EPS, `第 ${i + 1} 句與前一句重疊`);
    prevEnd = line.t1;
  }
});
