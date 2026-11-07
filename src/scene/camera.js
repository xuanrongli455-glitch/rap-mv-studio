// rap-mv/src/scene/camera.js — 20 秒分鏡的「純數學」。
// 這裡刻意不 import three：只是數學函式，可以在 node 裡直接單元測試。
// 全片以 20 秒為基準，config.duration 改變時用 k = duration / 20 等比縮放，
// 因此歌詞的 t0/t1（使用者是照 20 秒填的）也要乘上同一個 k。

import { clamp, easeInOutCubic, lerp, num, smoothstep } from './util.js';

// 原始 20 秒分鏡（秒）。這是「設計稿」，實際時間會乘上 k。
export const STORY = {
  introEnd: 2.6,   // 俯衝 + 標題浮現
  lyricsEnd: 16.2, // 穿越城市 + 4 句歌詞
  artistEnd: 18,   // 藝名 slam
  duration: 20,    // CTA 到 20 秒，最後 0.6 秒淡出
};

// 把絕對秒數換成「這支影片的比例位置」。
export function getTimeline(t, duration) {
  const D = Math.max(0.5, num(duration, STORY.duration));
  const k = D / STORY.duration;
  const tt = clamp(num(t, 0), 0, D);
  const introEnd = STORY.introEnd * k;
  const lyricsEnd = STORY.lyricsEnd * k;
  const artistEnd = STORY.artistEnd * k;

  let section = 'intro';
  if (tt >= artistEnd) section = 'cta';
  else if (tt >= lyricsEnd) section = 'artist';
  else if (tt >= introEnd) section = 'lyrics';

  return {
    t: tt,
    duration: D,
    k,
    introEnd,
    lyricsStart: introEnd,
    lyricsEnd,
    artistStart: lyricsEnd,
    artistEnd,
    ctaStart: artistEnd,
    end: D,
    section,
    phaseIntro: clamp(tt / Math.max(1e-4, introEnd), 0, 1),
    phaseLyrics: clamp((tt - introEnd) / Math.max(1e-4, lyricsEnd - introEnd), 0, 1),
    phaseArtist: clamp((tt - lyricsEnd) / Math.max(1e-4, artistEnd - lyricsEnd), 0, 1),
    phaseCta: clamp((tt - artistEnd) / Math.max(1e-4, D - artistEnd), 0, 1),
  };
}

// ── 各段的鏡頭公式 ──
// 拆成小函式的好處：下一段可以直接拿上一段的最後一格當起點，保證切段不跳畫面。

// ② 街道穿梭（p: 0..1）
function lyricsPose(p, I) {
  const lateral = Math.sin(p * Math.PI * 3.4) * 3.2 + Math.sin(p * Math.PI * 1.15) * 1.7;
  const px = lateral * I;
  const pz = 18 - 146 * p;
  const py = 3.6 + (Math.sin(p * Math.PI * 1.9) * 1.7 + Math.sin(p * Math.PI * 4.7) * 0.5) * I;
  return {
    pos: [px, py, pz],
    look: [
      px * 0.5 + Math.sin(p * Math.PI * 2.1) * 2.0 * I,
      py + 2.0 + Math.sin(p * Math.PI * 2.8) * 1.1,
      pz - 30,
    ],
    roll: Math.sin(p * Math.PI * 2.4) * 0.035 * I,
  };
}

// ③ 藝名 slam 的終點（也是 ④ 的起點）
const ARTIST_END = { pos: [0, 8.6, -140], look: [0, 7.2, -164] };
// ④ CTA 的終點（城市遠景）
const CTA_END = { pos: [0, 26, -116], look: [0, 10, -172] };

function lerp3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// 鏡頭路徑。回傳純資料（陣列），由 index.js 套用到 THREE.Camera。
export function cameraPath(t, duration, intensity) {
  const tl = getTimeline(t, duration);
  const it = clamp(num(intensity, 0.85), 0, 1);
  // I = 動態幅度倍率：intensity 0.85 → 約 1.3 倍搖擺。
  const I = 0.55 + it * 0.9;

  let pos;
  let look;
  let roll = 0;
  let fovOffset = 0;

  if (tl.t < tl.introEnd) {
    // ① 從高空俯衝進街道：先把城市壓在畫面下方，再貼地穿入。
    const e = easeInOutCubic(tl.phaseIntro);
    pos = [0, lerp(54, 3.6, e), lerp(76, 18, e)];
    const la = easeInOutCubic(clamp((tl.phaseIntro - 0.05) / 0.95, 0, 1));
    // 注視點最後一格 = ② 的第一格，交棒時不跳。
    const next = lyricsPose(0, I);
    look = [0, lerp(12, next.look[1], la), lerp(4, next.look[2], la)];
    roll = Math.sin(tl.phaseIntro * Math.PI) * 0.02 * I;
  } else if (tl.t < tl.lyricsEnd) {
    // ② 沿街道穿梭：等速前進 + 左右蛇行 + 上下浮沉，注視點略偏前方。
    const pose = lyricsPose(tl.phaseLyrics, I);
    pos = pose.pos;
    look = pose.look;
    roll = pose.roll;
  } else if (tl.t < tl.artistEnd) {
    // ③ 藝名 slam：承接 ② 的終點，鏡頭升起後退，同時用短暫的 fov 收縮做撞擊感。
    const p = tl.phaseArtist;
    const e = easeInOutCubic(p);
    const from = lyricsPose(1, I);
    pos = lerp3(from.pos, ARTIST_END.pos, e);
    look = lerp3(from.look, ARTIST_END.look, e);
    roll = lerp(from.roll, 0, e);
    fovOffset = -6.5 * Math.exp(-p * 5) * (0.6 + it * 0.6);
  } else {
    // ④ CTA：從 ③ 的終點一路拉高、後退，把整座城市當結尾遠景。
    const e = easeInOutCubic(tl.phaseCta);
    pos = lerp3(ARTIST_END.pos, CTA_END.pos, e);
    look = lerp3(ARTIST_END.look, CTA_END.look, e);
    roll = 0;
  }

  return { pos, look, roll, fovOffset, timeline: tl };
}

// 單句歌詞的時間狀態：聚合成字的進度、句末炸散的爆量、淡入淡出。
// line.t0/t1 是**影片絕對秒數**（和 autoDistributeLyrics 的輸出、lib/timeline 同一套語意），
// 不乘 k —— 歌詞貼著音檔，換片長時不該變形。分鏡（鏡頭／藝名／CTA）才按 k 等比例縮放。
export function lyricState(t, line) {
  const t0 = num(line && line.t0, 0);
  const t1 = num(line && line.t1, t0 + 0.8);
  const span = Math.max(0.25, t1 - t0);
  const p = (num(t, 0) - t0) / span;
  return {
    active: p > -0.12 && p < 1.12,
    progress: smoothstep(0.0, 0.3, p),
    burst: smoothstep(0.86, 1.0, p),
    opacity: smoothstep(-0.06, 0.1, p) * (1 - smoothstep(0.9, 1.02, p)),
    p,
  };
}

// fov 依畫面比例調整：直式維持大 fov（主體不爆框）、橫式收窄（城市更有壓迫感）。
export function fovForAspect(aspect) {
  const a = Math.max(0.05, num(aspect, 0.5625));
  if (a >= 1.5) return 47;
  if (a >= 1.05) return 52;
  if (a <= 0.8) return 61;
  return 56;
}
