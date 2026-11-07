// rap-mv/src/lib/timeline.js — 影片時間軸 / 歌詞排版（純函式，無 DOM / window / three）
//
// 對外 API（合約見 src/contract.md E 段）：
//   buildTimeline(config)                      → { sections: [{kind,t0,t1}], lyricAt(t) }
//   autoDistributeLyrics(lines, duration, lead, tail) → [{text,t0,t1}]
//   formatTime(sec)                            → '0:04.2'
//   clamp(v, a, b)
//
// 時間軸一律用「秒」，section 型別只有 intro / verse / hook / outro 四種。
// 所有函式都是純的：同樣輸入 → 同樣輸出，不讀寫任何全域狀態。

/** 把數值夾在 a..b（NaN → a；a > b 自動交換）。 */
export function clamp(v, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const n = Number(v);
  if (Number.isNaN(n)) return lo; // NaN / undefined / 非數值字串 → 下限
  return n < lo ? lo : n > hi ? hi : n;
}

/** 秒數 → '分:秒.十分位'，例如 4.2 → '0:04.2'、64.25 → '1:04.3'。 */
export function formatTime(sec) {
  let s = Number.isFinite(sec) ? sec : 0;
  if (s < 0) s = 0;
  // 先換成「十分位」整數四捨五入，避免 59.96 → '0:60.0' 這種進位錯誤
  const tenths = Math.round(s * 10);
  const minutes = Math.floor(tenths / 600);
  const restTenths = tenths - minutes * 600; // 0..599
  const whole = Math.floor(restTenths / 10);
  const frac = restTenths - whole * 10;
  return `${minutes}:${String(whole).padStart(2, '0')}.${frac}`;
}

// ── 內部：把歌詞整理成「已排序、已夾進 0..duration」的區間 ─────────
// 支援 {text,t0,t1} 與字串兩種；缺少時間的歌詞會交給 autoDistributeLyrics 處理。
function normalizeLyrics(lyrics, duration) {
  if (!Array.isArray(lyrics)) return [];
  const out = [];
  for (const line of lyrics) {
    if (line == null) continue;
    const obj = typeof line === 'string' ? { text: line } : line;
    const text = String(obj.text ?? '');
    const t0 = Number(obj.t0);
    const t1 = Number(obj.t1);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    const a = clamp(Math.min(t0, t1), 0, duration);
    const b = clamp(Math.max(t0, t1), 0, duration);
    if (b - a <= 0) continue;
    out.push({ text, t0: a, t1: b });
  }
  out.sort((p, q) => p.t0 - q.t0);
  return out;
}

/**
 * 依 config 建立時間軸。
 *
 * 切法：
 *   intro 0 .. 第一句歌詞開始
 *   verse 第一句開始 .. 歌詞區段一半
 *   hook  歌詞區段一半 .. outro 開始（至少涵蓋最後一句歌詞結束）
 *   outro 最後約 2 秒（CTA 收尾）
 *
 * 保證：sections 依時間排序、彼此不重疊且首尾相接、完整覆蓋 0..duration。
 * 若某些段落長度為 0（例如歌詞從 0 秒就開始，沒有 intro），該段會被省略。
 *
 * @param {object} config 見 src/config.js 的 defaultConfig
 * @returns {{sections: {kind:string,t0:number,t1:number}[], lyricAt: (t:number)=>({index:number,line:object,text:string,progress:number}|null)}}
 */
export function buildTimeline(config) {
  const cfg = config || {};
  const rawDuration = Number(cfg.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 20;

  const lyrics = normalizeLyrics(cfg.lyrics, duration);

  // ── 四個切點（全部單調遞增，最後會再保險排序一次）──
  let introEnd;
  let hookEnd; // hook 的結束 = outro 的開始
  if (lyrics.length > 0) {
    introEnd = clamp(lyrics[0].t0, 0, duration);
    // outro 至少從最後一句歌詞結束後才開始；若歌詞拖到最後，outro 可能變 0 長
    hookEnd = clamp(Math.max(lyrics[lyrics.length - 1].t1, introEnd), 0, duration);
    // 但 outro 最好吃「最後 2 秒」：若歌詞提早結束，hook 之後補一段 hook 過渡
    const outroStart = clamp(Math.max(hookEnd, duration - Math.min(2, duration * 0.12)), 0, duration);
    hookEnd = outroStart;
  } else {
    // 沒有歌詞：用比例切，讓場景仍有段落感
    introEnd = clamp(Math.min(2.6, duration * 0.2), 0, duration);
    hookEnd = clamp(duration - Math.min(2, duration * 0.15), introEnd, duration);
  }
  introEnd = clamp(introEnd, 0, hookEnd);
  const verseEnd = clamp(introEnd + (hookEnd - introEnd) * 0.5, introEnd, hookEnd);

  // ── 建立區段 → 過濾 0 長度 → 合併同 kind → 強制首尾相接 ──
  const raw = [
    { kind: 'intro', t0: 0, t1: introEnd },
    { kind: 'verse', t0: introEnd, t1: verseEnd },
    { kind: 'hook', t0: verseEnd, t1: hookEnd },
    { kind: 'outro', t0: hookEnd, t1: duration },
  ];

  const sections = [];
  for (const seg of raw) {
    if (!(seg.t1 - seg.t0 > 1e-6)) continue;
    const prev = sections[sections.length - 1];
    if (prev && prev.kind === seg.kind) {
      prev.t1 = seg.t1; // 合併相鄰同型別
      continue;
    }
    sections.push({ kind: seg.kind, t0: seg.t0, t1: seg.t1 });
  }

  // 最後保險：無論如何都讓鏈條從 0 接到 duration
  if (sections.length === 0) {
    sections.push({ kind: 'hook', t0: 0, t1: duration });
  } else {
    sections[0].t0 = 0;
    for (let i = 1; i < sections.length; i++) sections[i].t0 = sections[i - 1].t1;
    sections[sections.length - 1].t1 = duration;
  }

  // ── 查詢：某一秒正在唱哪一句 ──
  function lyricAt(t) {
    const tt = Number.isFinite(t) ? t : 0;
    if (tt < 0 || tt > duration || lyrics.length === 0) return null;
    for (let i = 0; i < lyrics.length; i++) {
      const line = lyrics[i];
      if (tt >= line.t0 && tt <= line.t1) {
        const span = line.t1 - line.t0;
        const progress = span > 0 ? clamp((tt - line.t0) / span, 0, 1) : 1;
        // line 保留完整物件（text/t0/t1），並額外給 text 方便直接顯示
        return { index: i, line, text: line.text, progress };
      }
    }
    return null;
  }

  return { sections, lyricAt, duration };
}

/**
 * 把 N 句歌詞均分在 duration*lead .. duration*tail 之間，句與句留 0.15 秒空隙。
 * 支援 lines 為字串或 {text} 物件。
 *
 * @param {(string|{text:string})[]} lines 歌詞
 * @param {number} duration 影片長度（秒）
 * @param {number} [lead=0.14] 開頭保留比例
 * @param {number} [tail=0.86] 結尾保留比例
 * @returns {{text:string,t0:number,t1:number}[]}
 */
export function autoDistributeLyrics(lines, duration, lead = 0.14, tail = 0.86) {
  const list = Array.isArray(lines) ? lines : [];
  const count = list.length;
  if (count === 0) return [];

  const dur = Number.isFinite(duration) && duration > 0 ? duration : 20;
  const l = clamp(Number.isFinite(lead) ? lead : 0.14, 0, 0.95);
  const tl = clamp(Number.isFinite(tail) ? tail : 0.86, l + 0.01, 1);
  const start = dur * l;
  const end = dur * tl;
  const span = Math.max(0, end - start);
  const gap = 0.15;

  // 有足夠空間才留句間空隙；太擠就退化成不留空隙，但保證 t1 > t0
  let slot = (span - gap * (count - 1)) / count;
  let useGap = gap;
  if (!(slot > 0.02)) {
    useGap = 0;
    slot = span / count;
  }
  // 仍然太窄（duration 極小）：至少給每句一個極小的正長度
  if (!(slot > 0)) slot = Math.max(span, 0.001) / count;
  const minLen = Math.min(0.2, Math.max(0.01, slot * 0.9));

  const result = [];
  for (let i = 0; i < count; i++) {
    const raw = typeof list[i] === 'string' ? list[i] : list[i] && list[i].text != null ? list[i].text : '';
    const text = String(raw);
    const t0 = start + i * (slot + useGap);
    let t1 = t0 + Math.max(slot, minLen);
    // 夾在 [start, end] 內，並確保不與下一句重疊
    const nextStart = i + 1 < count ? start + (i + 1) * (slot + useGap) : end;
    t1 = Math.min(t1, nextStart);
    const safeT0 = clamp(t0, start, end);
    const safeT1 = Math.max(clamp(t1, start, end), safeT0 + Math.min(minLen, Math.max(0, end - safeT0)));
    result.push({ text, t0: round3(safeT0), t1: round3(Math.min(safeT1, end)) });
  }
  return result;
}

// 時間取到毫秒級就好（避免 4.200000000000001 這種浮點噪聲）
function round3(v) {
  return Math.round(v * 1000) / 1000;
}
