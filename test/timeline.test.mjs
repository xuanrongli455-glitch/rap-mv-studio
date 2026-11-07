// rap-mv/test/timeline.test.mjs — src/lib/timeline.js 的單元測試
// 執行：node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  autoDistributeLyrics,
  formatTime,
  clamp,
} from '../src/lib/timeline.js';
import { defaultConfig } from '../src/config.js';

const KINDS = new Set(['intro', 'verse', 'hook', 'outro']);
const EPS = 1e-6;

// 檢查 sections 的共通不變量：排序、不重疊、首尾相接、完整覆蓋 0..duration
function assertSectionsValid(sections, duration) {
  assert.ok(Array.isArray(sections) && sections.length > 0, 'sections 不可為空');
  for (const s of sections) {
    assert.ok(KINDS.has(s.kind), `未知的 section 型別：${s.kind}`);
    assert.ok(Number.isFinite(s.t0) && Number.isFinite(s.t1));
    assert.ok(s.t1 > s.t0, `section ${s.kind} 長度必須 > 0：${s.t0}..${s.t1}`);
  }
  assert.ok(Math.abs(sections[0].t0) < EPS, `第一個 section 必須從 0 開始，實際 ${sections[0].t0}`);
  for (let i = 1; i < sections.length; i++) {
    assert.ok(
      Math.abs(sections[i].t0 - sections[i - 1].t1) < EPS,
      `section ${i} 必須接在 ${i - 1} 之後（${sections[i - 1].t1} vs ${sections[i].t0}）`,
    );
  }
  assert.ok(
    Math.abs(sections[sections.length - 1].t1 - duration) < EPS,
    `最後一個 section 必須結束在 duration=${duration}，實際 ${sections[sections.length - 1].t1}`,
  );
}

// ── buildTimeline ───────────────────────────────────────────────
test('buildTimeline：預設 config 切出 intro/verse/hook/outro 且完整覆蓋（片長由 config 決定）', () => {
  const tl = buildTimeline(defaultConfig);
  const D = defaultConfig.duration;
  assertSectionsValid(tl.sections, D);

  const firstLyric = defaultConfig.lyrics[0];
  const lastLyric = defaultConfig.lyrics[defaultConfig.lyrics.length - 1];

  const intro = tl.sections[0];
  assert.equal(intro.kind, 'intro');
  assert.ok(Math.abs(intro.t0) < EPS);
  assert.ok(
    Math.abs(intro.t1 - firstLyric.t0) < EPS,
    `intro 應在首句歌詞 ${firstLyric.t0}s 結束，實際 ${intro.t1}`,
  );

  const last = tl.sections[tl.sections.length - 1];
  assert.equal(last.kind, 'outro');
  assert.ok(Math.abs(last.t1 - D) < EPS);
  assert.ok(
    Math.abs(last.t0 - lastLyric.t1) < EPS,
    `outro 應從最後一句歌詞結束 ${lastLyric.t1}s 開始，實際 ${last.t0}`,
  );

  // 四種 kind 都要出現
  const kinds = new Set(tl.sections.map((s) => s.kind));
  for (const k of KINDS) assert.ok(kinds.has(k), `缺少 section：${k}`);
});

test('buildTimeline：沒有歌詞時仍完整覆蓋且不重疊', () => {
  for (const duration of [3, 12, 20, 45]) {
    const tl = buildTimeline({ duration, lyrics: [] });
    assertSectionsValid(tl.sections, duration);
    assert.equal(tl.lyricAt(duration / 2), null);
  }
});

test('buildTimeline：歌詞貼齊全片時 sections 仍合法（可能省略 intro/outro）', () => {
  const cfg = {
    duration: 10,
    lyrics: [
      { text: '第一句', t0: 0, t1: 5 },
      { text: '第二句', t0: 5, t1: 10 },
    ],
  };
  const tl = buildTimeline(cfg);
  assertSectionsValid(tl.sections, 10);
  const kinds = tl.sections.map((s) => s.kind);
  assert.ok(kinds.includes('verse') || kinds.includes('hook'));
  // 覆蓋率驗證：每一秒都落在某個 section 內
  for (let t = 0; t <= 10; t += 0.25) {
    const hit = tl.sections.some((s) => t >= s.t0 - EPS && t <= s.t1 + EPS);
    assert.ok(hit, `t=${t} 沒有被任何 section 覆蓋`);
  }
});

test('buildTimeline：duration 不合法時用安全預設值', () => {
  for (const duration of [0, -5, NaN, undefined, 'abc']) {
    const tl = buildTimeline({ duration, lyrics: [] });
    assertSectionsValid(tl.sections, 20);
  }
});

// ── lyricAt ─────────────────────────────────────────────────────
test('lyricAt：邊界（t=0、t=duration、歌詞中點）', () => {
  const tl = buildTimeline(defaultConfig);

  const D = defaultConfig.duration;
  // 首句之前與影片尾端之外 → null（歌詞不從 0 秒開始，片長也不是舊的 20 秒）
  assert.equal(tl.lyricAt(0), null);
  assert.equal(tl.lyricAt(D), null);
  assert.equal(tl.lyricAt(-1), null);
  assert.equal(tl.lyricAt(D + 1), null);

  // 第一句的中點（由 config 推，不寫死秒數）
  const first = defaultConfig.lyrics[0];
  const mid = tl.lyricAt((first.t0 + first.t1) / 2);
  assert.ok(mid, '歌詞中點應回傳物件');
  assert.equal(mid.index, 0);
  assert.equal(mid.text, defaultConfig.lyrics[0].text);
  assert.equal(mid.line.text, defaultConfig.lyrics[0].text);
  assert.ok(Math.abs(mid.progress - 0.5) < 0.02, `progress 應約 0.5，實際 ${mid.progress}`);

  // 歌詞開頭的精確邊界
  const atStart = tl.lyricAt(first.t0);
  assert.ok(atStart && atStart.index === 0 && Math.abs(atStart.progress) < EPS);

  // 每一句的中點都要能命中
  for (let i = 0; i < defaultConfig.lyrics.length; i++) {
    const line = defaultConfig.lyrics[i];
    const hit = tl.lyricAt((line.t0 + line.t1) / 2);
    assert.ok(hit && hit.index === i, `第 ${i} 句中點沒命中`);
    assert.equal(hit.line.t0, line.t0);
    assert.equal(hit.line.t1, line.t1);
    assert.ok(hit.progress > 0.45 && hit.progress < 0.55);
  }
});

test('lyricAt：歌詞剛好從 0 開始、到 duration 結束時 progress 分別為 0 與 1', () => {
  const tl = buildTimeline({
    duration: 10,
    lyrics: [{ text: '整片', t0: 0, t1: 10 }],
  });
  const first = tl.lyricAt(0);
  const last = tl.lyricAt(10);
  assert.ok(first && last);
  assert.equal(first.progress, 0);
  assert.equal(last.progress, 1);
});

test('lyricAt：歌詞之間的空隙回傳 null', () => {
  const tl = buildTimeline({
    duration: 10,
    lyrics: [
      { text: 'A', t0: 1, t1: 2 },
      { text: 'B', t0: 5, t1: 6 },
    ],
  });
  assert.equal(tl.lyricAt(3.5), null);
  assert.equal(tl.lyricAt(4.99), null);
  assert.ok(tl.lyricAt(1.5));
  assert.ok(tl.lyricAt(5.5));
});

// ── autoDistributeLyrics ────────────────────────────────────────
test('autoDistributeLyrics：4 句均分在 lead..tail 內、依序且不重疊', () => {
  const lines = ['一句', '兩句', '三句', '四句'];
  const duration = 20;
  const lead = 0.14;
  const tail = 0.86;
  const out = autoDistributeLyrics(lines, duration, lead, tail);

  assert.equal(out.length, 4);
  const start = duration * lead;
  const end = duration * tail;

  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].text, lines[i]);
    assert.ok(out[i].t1 > out[i].t0, `第 ${i} 句 t1 必須 > t0`);
    assert.ok(out[i].t0 >= start - EPS, `第 ${i} 句 t0 超出 lead 範圍`);
    assert.ok(out[i].t1 <= end + EPS, `第 ${i} 句 t1 超出 tail 範圍`);
    if (i > 0) {
      assert.ok(out[i].t0 > out[i - 1].t0, '歌詞時間必須遞增');
      assert.ok(out[i].t0 >= out[i - 1].t1, '歌詞不可重疊');
      // 句間應留約 0.15s 空隙
      assert.ok(
        Math.abs(out[i].t0 - out[i - 1].t1 - 0.15) < 0.011,
        `第 ${i} 句空隙應約 0.15s，實際 ${(out[i].t0 - out[i - 1].t1).toFixed(3)}`,
      );
    }
  }
  // 覆蓋起點與終點
  assert.ok(Math.abs(out[0].t0 - start) < EPS);
  assert.ok(Math.abs(out[out.length - 1].t1 - end) < EPS);
});

test('autoDistributeLyrics：支援 {text} 物件、N=0、N=1', () => {
  const objs = autoDistributeLyrics([{ text: '甲' }, { text: '乙' }], 20);
  assert.equal(objs.length, 2);
  assert.deepEqual(objs.map((o) => o.text), ['甲', '乙']);

  assert.deepEqual(autoDistributeLyrics([], 20), []);

  const one = autoDistributeLyrics(['唯一一句'], 20);
  assert.equal(one.length, 1);
  assert.equal(one[0].text, '唯一一句');
  assert.ok(one[0].t1 > one[0].t0);
  assert.ok(one[0].t0 >= 20 * 0.14 - EPS);
  assert.ok(one[0].t1 <= 20 * 0.86 + EPS);

  // 不是陣列也不應丢例外
  assert.deepEqual(autoDistributeLyrics(null, 20), []);
  assert.deepEqual(autoDistributeLyrics(undefined, 20), []);
});

test('autoDistributeLyrics：句子很多、影片很短時仍不抛錯且 t1 > t0', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `第 ${i} 句`);
  const out = autoDistributeLyrics(lines, 12);
  assert.equal(out.length, 50);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i].t1 > out[i].t0, `第 ${i} 句長度必須 > 0：${out[i].t0}..${out[i].t1}`);
    assert.ok(Number.isFinite(out[i].t0) && Number.isFinite(out[i].t1));
  }
  // 極端：200 句塞 1 秒也不能爆
  const dense = autoDistributeLyrics(Array.from({ length: 200 }, (_, i) => `${i}`), 1);
  assert.equal(dense.length, 200);
  assert.ok(dense.every((o) => o.t1 > o.t0));
});

test('autoDistributeLyrics：自訂 lead/tail', () => {
  const out = autoDistributeLyrics(['a', 'b'], 10, 0.2, 0.8);
  assert.ok(Math.abs(out[0].t0 - 2) < EPS);
  assert.ok(Math.abs(out[1].t1 - 8) < EPS);
});

// ── formatTime / clamp ─────────────────────────────────────────
test('formatTime：分:秒.十分位，秒補零', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(4.2), '0:04.2');
  assert.equal(formatTime(4.26), '0:04.3');
  assert.equal(formatTime(9.96), '0:10.0');
  assert.equal(formatTime(59.97), '1:00.0');
  assert.equal(formatTime(64.25), '1:04.3');
  assert.equal(formatTime(125), '2:05.0');
  assert.equal(formatTime(-3), '0:00.0');
  assert.equal(formatTime(NaN), '0:00.0');
});

test('clamp：夾在範圍內，NaN 回下限，a>b 也能處理', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(2, 5, 1), 2);
  assert.equal(clamp(NaN, 2, 4), 2);
  assert.equal(clamp(Infinity, 0, 1), 1);
});
