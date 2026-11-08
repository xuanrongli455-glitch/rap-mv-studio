// rap-mv/src/config.js — 唯一的資料來源：所有可調參數都在這裡。
// 使用者可以用頁面 UI 即時改，改了會存在 localStorage 並回寫到 window.__MV_CONFIG__。

export const PALETTES = {
  neon: {
    label: '霓虹賽博',
    bg: '#05010d',
    fog: '#12042a',
    key: '#00e5ff',      // 主光 / 招牌
    accent: '#ff2bd6',   // 副色 / 歌詞
    special: '#b14bff',  // 紫
    text: '#ffffff',
    ground: '#0b0518',
  },
  cyberdark: {
    label: '暗黑金屬',
    bg: '#020203',
    fog: '#0a0a0c',
    key: '#ffb300',
    accent: '#ff3b1f',
    special: '#d4af37',
    text: '#f5f5f5',
    ground: '#050506',
  },
  vapor: {
    label: '粉紫蒸氣波',
    bg: '#1a0b2e',
    fog: '#2b1055',
    key: '#ff6ec7',
    accent: '#37e2ff',
    special: '#ffd166',
    text: '#ffffff',
    ground: '#120722',
  },
  graffiti: {
    label: '街頭塗鴉',
    bg: '#0e0e0e',
    fog: '#1b1b1b',
    key: '#ffd400',
    accent: '#00ff85',
    special: '#ff2b6d',
    text: '#ffffff',
    ground: '#141414',
  },
};

// localStorage 的設定 key。改預設值（例如換歌）時要把版本號往上跳，
// 否則使用者瀏覽器裡的舊設定會在 loadConfig() 的 {...base, ...saved} 把新預設值蓋回去。
export const CONFIG_STORAGE_KEY = 'rap-mv:config:v2';

// 成片分鏡（秒）。lyrics 的 t0/t1 是**影片絕對秒數**（不隨 duration 縮放）：
// 歌詞屬於音檔，換片長時歌詞不該跟著變形。分鏡的鏡頭比例才是按 duration/20 等比縮放。
export const defaultConfig = {
  // ── 文字資料：SOMBRA《Night Shift》（2026-11-07 使用者提供）──
  title: 'Night Shift',
  artist: 'SOMBRA',
  tagline: 'NEW SINGLE',
  cta: 'OUT NOW',
  // 15 句對應實際音檔的四段人聲（能量分析：7.06–23.31 / 24.18–36.90 / 41.31–55.01 / 56.71–61.88）
  // 結構：副歌 4 句 → 主歌 6 句 → 副歌重複 4 句 → 收尾 1 句
  lyrics: [
    { text: "No sleep, night shift, yeah, I'm on the night shift (yeah)", t0: 7.06, t1: 10.77 },
    { text: "Laptop glow, block and yellow, that's the night shift (what)", t0: 11.12, t1: 14.83 },
    { text: 'Runnin\u2019 up a check while the city sleep (sleep)', t0: 15.18, t1: 18.89 },
    { text: 'Rage in my veins, too turnt to be weak (yeah)', t0: 19.24, t1: 22.95 },
    { text: '3AM, screen light on my face (face)', t0: 24.18, t1: 26.05 },
    { text: 'Qingdao to the world, yeah, I set the pace (pace)', t0: 26.3, t1: 28.17 },
    { text: 'Clouds in the server, smoke in the air (air)', t0: 28.42, t1: 30.29 },
    { text: "They talkin' down, I don't even care (care)", t0: 30.54, t1: 32.41 },
    { text: "Money callin', yeah, I gotta pick up (pick up)", t0: 32.66, t1: 34.53 },
    { text: "Underground king, yeah, I'm risin' up (up)", t0: 34.78, t1: 36.65 },
    { text: "No sleep, night shift, yeah, I'm on the night shift (yeah)", t0: 41.31, t1: 44.39 },
    { text: "Laptop glow, block and yellow, that's the night shift (what)", t0: 44.74, t1: 47.82 },
    { text: 'Runnin\u2019 up a check while the city sleep (sleep)', t0: 48.17, t1: 51.25 },
    { text: 'Rage in my veins, too turnt to be weak (yeah)', t0: 51.6, t1: 54.68 },
    { text: "I'm on the night shift", t0: 56.71, t1: 61.3 },
  ],

  // ── 規格 ──
  duration: 62.76,          // = 歌曲長度（48kHz／16-bit／stereo，實測 62.760 秒）
  fps: 30,
  ratio: '9:16',            // '9:16' | '16:9' | '1:1'
  bpm: 93.5,                // beat.js 對整首歌的偵測值（confidence 0.124，偏低；面板可改）
  palette: 'neon',

  // ── 節奏／動態強度（0-1） ──
  intensity: 0.85,          // 鏡頭推移與燈光脈動的力道
  shake: 0.45,              // 節拍震動
  bloom: 0.9,               // 光暈強度
  grain: 0.35,              // 底片顆粒

  // ── 文字顏色（空字串＝跟隨配色；填 #rrggbb 就強制用這個顏色）──
  lyricColor: '',          // 歌詞
  titleColor: '',          // 歌名／藝名／標語／CTA

  // ── 場景元素開關 ──
  showCity: true,
  showVinyl: true,
  showMic: true,
  showParticles: true,
  showLyrics: true,
  showPortrait: false,  // 照片粒子人像（預設關，改用 3D 角色）
  showAvatar: true,     // 3D 動漫角色（VRM / GLB，模型在本機處理）
  avatarFlip: false,    // 角色背對鏡頭時勾起來（VRM 常見朝 -Z）
  avatarHeight: 8,      // 角色在世界裡的高度（世界單位）
  showRain: true,
};

export function loadConfig() {
  const base = structuredClone(defaultConfig);
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    const merged = { ...base, ...saved };
    if (!Array.isArray(merged.lyrics) || merged.lyrics.length === 0) merged.lyrics = base.lyrics;
    if (!PALETTES[merged.palette]) merged.palette = 'neon';
    return merged;
  } catch {
    return base;
  }
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch { /* 私密瀏覽可能失敗，忽略 */ }
}

export const RATIOS = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
};
