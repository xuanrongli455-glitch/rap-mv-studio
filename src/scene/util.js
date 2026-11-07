// rap-mv/src/scene/util.js — 場景共用小工具。
// 設計原則：模組頂層只放「常數」與「函式定義」，不建立任何 DOM / WebGL / three 資源，
// 這樣 main.js 就算在 createScene 失敗時也不會因為 import 這個檔案而出錯。

export const TAU = Math.PI * 2;

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 把 UI 傳進來的值（可能是字串 / NaN / undefined）安全轉成數字。
export function num(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

export function mod(n, m) {
  return ((n % m) + m) % m;
}

export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeInOutCubic(x) {
  const t = clamp(x, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(x) {
  const t = clamp(x, 0, 1);
  const p = 1 - t;
  return 1 - p * p * p;
}

// 會稍微「衝過頭」再彈回，用來做 slam 的縮放進場。
export function easeOutBack(x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t = clamp(x, 0, 1);
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

// ── 固定種子 PRNG ──
// update() 必須是純時間函式，所以任何看起來隨機的東西都在建模期用固定種子產生，
// 播放時只查表、不再抽亂數。
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 同一個 tag 只警告一次，避免 update() 每幀洗版（iOS 上 console 洗版會明顯拖慢）。
export function createLogger() {
  const seen = new Set();
  return function warn(tag, err) {
    if (seen.has(tag)) return;
    seen.add(tag);
    try {
      const detail = err && (err.stack || err.message) ? (err.message || err) : err;
      console.warn(`[scene] ${tag}`, detail === undefined ? '' : detail);
    } catch {
      /* console 不可用時忽略 */
    }
  };
}

// 2D 離屏 canvas。只有「取樣文字像素」與「程序化貼圖」會用到，不是 WebGL 資源。
export function createCanvas2D(w, h) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(w));
    canvas.height = Math.max(1, Math.floor(h));
    // willReadFrequently：文字取樣要 getImageData，這個提示讓 Safari 走 CPU 後端，快很多。
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    return { canvas, ctx };
  } catch {
    return null;
  }
}

// 遞迴釋放整棵子樹的 geometry / material / texture。
// 用 Set 去重，因為 InstancedMesh 與 clone 出來的網格常常共用同一份資源。
export function disposeObject3D(root) {
  if (!root || typeof root.traverse !== 'function') return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  root.traverse((obj) => {
    if (obj.geometry) geometries.add(obj.geometry);
    const mat = obj.material;
    if (mat) {
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        if (!m) continue;
        materials.add(m);
        for (const key in m) {
          const value = m[key];
          if (value && value.isTexture) textures.add(value);
        }
        // ShaderMaterial 的貼圖可能藏在 uniforms 裡
        if (m.uniforms) {
          for (const key in m.uniforms) {
            const value = m.uniforms[key] && m.uniforms[key].value;
            if (value && value.isTexture) textures.add(value);
          }
        }
      }
    }
  });

  geometries.forEach((g) => {
    try { g.dispose(); } catch { /* 已釋放 */ }
  });
  materials.forEach((m) => {
    try { m.dispose(); } catch { /* 已釋放 */ }
  });
  textures.forEach((t) => {
    try { t.dispose(); } catch { /* 已釋放 */ }
  });
}
