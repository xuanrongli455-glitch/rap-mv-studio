// rap-mv/src/scene/portrait.js — 把使用者的照片取樣成「有厚度的 3D 粒子人像」。
//
// 為什麼這樣做（而不是貼一張平面圖）：
//   鏡頭沿街道飛過去時，粒子有 z 深度 → 會產生真正的視差，看起來是「站在城市裡的立體形象」，
//   而不是一張貼紙。亮的地方往前浮、暗的地方往後退，輪廓會自己立體起來。
//
// 兩種照片自動判斷：
//   ① 去背 PNG（透明背景）→ 加法混合，霓虹人形，效果最好（iPad 照片長按主體即可拷貝）
//   ② 一般照片 → 正常混合 + 橢圓柔邊 + 青色霓虹染色（不然深色衣服在暗場景裡會整片看不見）
import * as THREE from 'three';

// 取樣解析度：先縮到這個寬度再逐像素掃（220 寬時，半身照的臉約有 60px 可分配粒子）
const SAMPLE_W = 220;
// 目標粒子數（場景會用 group.scale 縮到世界尺寸）
const TARGET_COUNT = 12000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleImage(image, opts) {
  const { count = TARGET_COUNT, threshold = 0.1, seed = 1, tint = null } = opts || {};
  if (typeof document === 'undefined') throw new Error('這個環境沒有 canvas（需要瀏覽器）');

  const srcW = image.width;
  const srcH = image.height;
  const w = Math.max(8, SAMPLE_W);
  // 直式全身照 → 預設取上半身（頭到胸），否則臉分不到足夠粒子
  const tall = srcH / srcW > 1.35;
  const cropTop = 0;
  const cropBottom = tall ? 0.64 : 1;
  const h = Math.max(8, Math.round(w * ((srcH * (cropBottom - cropTop)) / srcW)));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('無法建立 2D context');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(
    image,
    0, Math.round(srcH * cropTop), srcW, Math.max(1, Math.round(srcH * (cropBottom - cropTop))),
    0, 0, w, h,
  );

  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    throw new Error('讀不到照片像素（可能是跨網域限制）');
  }

  // 先判斷是不是去背圖：透明像素夠多 → 霓虹人形
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 230) transparent += 1;
  const hasAlpha = transparent / Math.max(1, w * h) > 0.06;

  // 收集合格像素
  const cells = [];
  let lumSum = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      if (a < 0.25) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (hasAlpha && lum < threshold) continue; // 只有去背圖才需要丟近黑雜點
      lumSum += lum;
      cells.push({ x, y, r, g, b, lum });
    }
  }
  if (cells.length < 40) {
    throw new Error('照片太暗或幾乎空白（請換一張光線充足的照片，或先用「去背」版本）');
  }

  // 均勻隨機抽樣（固定種子）。
  // 注意：不能用「每 N 個取一個」——cells 是逐列收集的，等距取樣會在畫面上留下明顯直條紋。
  const density = Math.min(1, count / cells.length);
  const pick = mulberry32(seed ^ 0x9e3779b9);
  const softMask = !hasAlpha; // 一般照片用橢圓柔邊，避免變成「一塊發光的長方形」
  const kept = [];
  for (const cell of cells) {
    if (pick() > density) continue;
    if (softMask) {
      const u = cell.x / Math.max(1, w - 1) - 0.5;
      const v = cell.y / Math.max(1, h - 1) - 0.5;
      const e = (u / 0.46) ** 2 + (v / 0.5) ** 2;
      const keepP = Math.max(0, Math.min(1, (1 - e) / 0.22));
      if (pick() > keepP) continue;
    }
    kept.push(cell);
  }

  const n = kept.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const jitter = mulberry32(seed);
  const tintColor = tint ? new THREE.Color(tint) : null;
  const tintMix = hasAlpha ? 0.06 : 0.26; // 一般照片混多一點霓虹色，深色衣服才看得見
  const gamma = hasAlpha ? 1.0 : 0.82;    // 提亮暗部
  const boost = hasAlpha ? 1.18 : 1.05;

  for (let k = 0; k < n; k += 1) {
    const cell = kept[k];
    const u = cell.x / Math.max(1, w - 1);
    const v = cell.y / Math.max(1, h - 1);
    // 正規化：高度約 1、寬度按長寬比（不變形）
    const px = (u - 0.5) * (w / Math.max(w, h));
    const py = (0.5 - v) * (h / Math.max(w, h));
    // 亮度 → 深度：亮的往前、暗的往後
    const pz = (cell.lum - 0.45) * 0.34 + (jitter() - 0.5) * 0.02;

    pos[k * 3] = px + (jitter() - 0.5) * 0.0016;
    pos[k * 3 + 1] = py + (jitter() - 0.5) * 0.0016;
    pos[k * 3 + 2] = pz;

    let cr = Math.min(1, cell.r ** gamma * boost);
    let cg = Math.min(1, cell.g ** gamma * boost);
    let cb = Math.min(1, cell.b ** gamma * boost);
    if (tintColor) {
      cr = cr * (1 - tintMix) + tintColor.r * tintMix;
      cg = cg * (1 - tintMix) + tintColor.g * tintMix;
      cb = cb * (1 - tintMix) + tintColor.b * tintMix;
    }
    col[k * 3] = cr;
    col[k * 3 + 1] = cg;
    col[k * 3 + 2] = cb;
  }

  return { position: pos, color: col, count: n, aspect: w / h, hasAlpha, clipped: tall && !hasAlpha };
}

/**
 * 建立 3D 粒子人像。幾何建在「正規化空間」（高度約 1），由呼叫端用 group.scale 縮到世界尺寸。
 * @param {{image: Image|HTMLImageElement|ImageBitmap, count?: number, seed?: number, particleSize?: number, tint?: string, threshold?: number}} opts
 */
export function createParticlePortrait({ image, count = TARGET_COUNT, seed = 1, particleSize = 0.0036, tint = null, threshold = 0.1 } = {}) {
  if (!image || !image.width || !image.height) throw new Error('沒有可用的照片');

  const sampled = sampleImage(image, { count, seed, tint, threshold });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(sampled.position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(sampled.color, 3));
  geometry.computeBoundingSphere();

  const material = new THREE.PointsMaterial({
    size: sampled.hasAlpha ? particleSize : particleSize * 1.15,
    vertexColors: true,
    transparent: true,
    opacity: sampled.hasAlpha ? 0.92 : 0.9,
    depthWrite: false,
    // 去背人形 → 加法混合（霓虹光感）；一般照片 → 正常混合（保留原色、不整片過曝）
    blending: sampled.hasAlpha ? THREE.AdditiveBlending : THREE.NormalBlending,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false; // 群組會被縮放/旋轉，正規化空間算出來的包圍球會誤判

  const group = new THREE.Group();
  group.add(points);

  let disposed = false;

  return {
    object: group,
    count: sampled.count,
    aspect: sampled.aspect,
    hasAlpha: sampled.hasAlpha,
    clipped: sampled.clipped,
    setVisible(v) {
      group.visible = v !== false;
    },
    // 純時間函式：慢速左右轉（3D 感）+ 節拍脈動
    update(t, beat = 0) {
      if (disposed) return;
      const tt = Number.isFinite(t) ? t : 0;
      group.rotation.y = Math.sin(tt * 0.42) * 0.28;
      group.rotation.x = Math.sin(tt * 0.27 + 0.8) * 0.045;
      group.position.y = Math.sin(tt * 1.1) * 0.01 + beat * 0.012;
      const pulse = 1 + beat * 0.018;
      points.scale.setScalar(pulse);
      points.material.opacity = (sampled.hasAlpha ? 0.82 : 0.82) + beat * 0.14;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { group.parent && group.parent.remove(group); } catch { /* ignore */ }
      try { geometry.dispose(); } catch { /* ignore */ }
      try { material.dispose(); } catch { /* ignore */ }
    },
  };
}
