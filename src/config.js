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

// 20 秒直式成片的分鏡（秒）。lyrics 的 t0/t1 決定 3D 歌詞何時出現。
export const defaultConfig = {
  // ── 文字資料：使用者自己填 ──
  title: '夜行者',
  artist: 'DIZZY 24',
  tagline: 'NEW SINGLE',
  cta: 'OUT NOW',
  lyrics: [
    { text: '夜行者 降臨 街燈為我讓路', t0: 2.6, t1: 6.0 },
    { text: '城市在低頻裡 跟著我呼吸', t0: 6.0, t1: 9.4 },
    { text: '沒人看好 那就自己開一條路', t0: 9.4, t1: 12.8 },
    { text: '音量開到最大 讓世界閉嘴', t0: 12.8, t1: 16.2 },
  ],

  // ── 規格 ──
  duration: 20,
  fps: 30,
  ratio: '9:16',            // '9:16' | '16:9' | '1:1'
  bpm: 92,
  palette: 'neon',

  // ── 節奏／動態強度（0-1） ──
  intensity: 0.85,          // 鏡頭推移與燈光脈動的力道
  shake: 0.45,              // 節拍震動
  bloom: 0.9,               // 光暈強度
  grain: 0.35,              // 底片顆粒

  // ── 場景元素開關 ──
  showCity: true,
  showVinyl: true,
  showMic: true,
  showParticles: true,
  showLyrics: true,
  showRain: true,
};

export function loadConfig() {
  const base = structuredClone(defaultConfig);
  try {
    const raw = localStorage.getItem('rap-mv:config:v1');
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
    localStorage.setItem('rap-mv:config:v1', JSON.stringify(cfg));
  } catch { /* 私密瀏覽可能失敗，忽略 */ }
}

export const RATIOS = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
};
