// rap-mv/src/scene/text.js — 3D 粒子文字。
//
// 原理：先把文字畫到 2D 離屏 canvas，掃描 alpha 像素當成「目標點」，
// 每個粒子另外配一個散開的起始點，再用 vertex shader 在 uProgress 0→1 之間把粒子從
// 散開位置吸到文字上（uBurst 則相反，句末炸散）。
//
// 為什麼動畫放在 shader 而不是每幀改 CPU 的 position 陣列？
// iPhone 上每幀搬 1~2 萬個頂點很吃 CPU，而這裡每幀只需要更新幾個 uniform，
// 幾何資料在建立後就固定不動，這也是「同一 t 得到同一畫面」最容易保證的做法。

import * as THREE from 'three';
import { clamp, createCanvas2D, mulberry32, TAU } from './util.js';

const FONT_STACK =
  '"PingFang TC", "Hiragino Sans TC", "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue", Arial, sans-serif';

// 取樣畫布尺寸：1280x360 對中文歌詞來說剛好（夠解析度又不至於 getImageData 太慢）。
const SAMPLE_W = 1280;
const SAMPLE_H = 360;

const PARTICLES_VERT = /* glsl */ `
attribute vec3 aScatter;
attribute float aSeed;
attribute float aMix;

uniform float uTime;
uniform float uProgress;
uniform float uBurst;
uniform float uOpacity;
uniform float uScale;
uniform float uPointScale;
uniform float uSize;
uniform vec3 uColorA;
uniform vec3 uColorB;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 target = position;

  // 每顆粒子有自己的 delay，所以整句字會「由散亂中陸續歸位」而不是同步跳過去。
  float delay = aSeed * 0.5;
  float p = smoothstep(delay, delay + 0.5, uProgress);

  vec3 pos = mix(aScatter, target, p);

  // 未歸位前持續漂浮；歸位後只留一點呼吸感，讓字看起來是活的。
  float idle = 1.0 - p * 0.72;
  pos += vec3(
    sin(uTime * 1.9 + aSeed * 41.0),
    cos(uTime * 1.6 + aSeed * 23.0),
    sin(uTime * 1.3 + aSeed * 31.0)
  ) * (0.04 * idle);

  // 炸散：往原本的散開方向噴出去，外加一點重力感。
  float b = uBurst;
  vec3 dir = normalize(aScatter + vec3(0.0001, 0.0001, 0.0001));
  pos += dir * (b * (2.2 + aSeed * 6.0) * 1.7);
  pos.y -= b * b * 1.1 * aSeed;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  // 尺寸衰減：uPointScale = 畫布高度/2，換算成裝置像素；uSize 是世界單位。
  float psize = uSize * uScale * (0.55 + aSeed * 0.9) * (1.0 + b * 0.65);
  gl_PointSize = clamp(psize * uPointScale / max(0.5, -mv.z), 1.0, 56.0);

  vColor = mix(uColorA, uColorB, aMix);
  vAlpha = uOpacity * (1.0 - b * 0.85);
}
`;

const PARTICLES_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  float a = 1.0 - smoothstep(0.02, 0.25, r2);
  if (a <= 0.01) discard;
  // 疊加混色時中心會自然過曝，稍微壓一下讓 bloom 只吃邊緣光暈。
  gl_FragColor = vec4(vColor * (1.0 + vAlpha * 0.25), a * vAlpha);
}
`;

// 把文字排進 canvas：先試大字，太寬就折成兩行，再依最寬行縮字級。
function layoutText(ctx, rawText) {
  const text = String(rawText == null ? '' : rawText).trim() || ' ';
  let lines = [text];
  let font = Math.min(SAMPLE_H * 0.66, 240);

  ctx.font = `bold ${font}px ${FONT_STACK}`;
  let widest = ctx.measureText(text).width;

  // 一句太長就從中間（優先空白處）折成兩行，比無限縮字看得清楚。
  if (widest > SAMPLE_W * 0.94 && text.length > 5) {
    const mid = Math.floor(text.length / 2);
    let split = mid;
    for (let d = 1; d < mid; d += 1) {
      if (text[mid - d] === ' ') { split = mid - d; break; }
      if (text[mid + d] === ' ') { split = mid + d + 1; break; }
    }
    const a = text.slice(0, split).trim();
    const b = text.slice(split).trim();
    if (a && b) lines = [a, b];
  }

  const measure = () => {
    ctx.font = `bold ${font}px ${FONT_STACK}`;
    return Math.max(...lines.map((l) => ctx.measureText(l).width));
  };

  widest = measure();
  const maxW = SAMPLE_W * 0.92;
  if (widest > maxW) font = Math.max(30, Math.floor((font * maxW) / widest));

  let lineH = font * 1.16;
  let totalH = lineH * lines.length;
  if (totalH > SAMPLE_H * 0.9) {
    font = Math.max(26, Math.floor((font * SAMPLE_H * 0.9) / totalH));
    lineH = font * 1.16;
    totalH = lineH * lines.length;
  }

  return { lines, font, lineH, totalH };
}

// 真正取樣：回傳 { position, scatter, seeds, mixes, aspect } 或 null（環境不支援 canvas）。
function sampleText(rawText, count, seed, particleSize) {
  const pair = createCanvas2D(SAMPLE_W, SAMPLE_H);
  if (!pair) return null;
  const { ctx } = pair;

  const { lines, font, lineH, totalH } = layoutText(ctx, rawText);
  ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${font}px ${FONT_STACK}`;
  const left = SAMPLE_W / 2;
  const top = SAMPLE_H / 2 - totalH / 2 + lineH * 0.5;
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], left, top + i * lineH);
  }

  let data;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  } catch {
    return null; // 理論上不會發生（本地 canvas 無跨域污染），保險起見。
  }

  // 掃描候選像素：stride 2 已經足夠密，粒子本來就是「霧狀」的。
  const xs = [];
  const ys = [];
  for (let y = 1; y < SAMPLE_H; y += 2) {
    const row = y * SAMPLE_W;
    for (let x = 1; x < SAMPLE_W; x += 2) {
      if (data[(row + x) * 4 + 3] > 110) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  const cand = xs.length;
  if (cand < 12) return null;

  // 以文字實際筆畫的外框做正規化：外框高度 = 1 世界單位，寬度 = aspect。
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < cand; i += 1) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const n = Math.max(24, Math.floor(count));
  const rng = mulberry32((seed >>> 0) || 1);

  const position = new Float32Array(n * 3);
  const scatter = new Float32Array(n * 3);
  const seeds = new Float32Array(n);
  const mixes = new Float32Array(n);

  for (let i = 0; i < n; i += 1) {
    // 從候選像素裡「抽樣」（允許重複，反而讓筆畫密度更自然）。
    const k = Math.floor(rng() * cand);
    const px = xs[k];
    const py = ys[k];
    const nx = (px - cx) / spanY;
    const ny = -(py - cy) / spanY;
    position[i * 3] = nx;
    position[i * 3 + 1] = ny;
    // 一點點 z 厚度，讓粒子字有立體感而不是全貼在同一平面。
    position[i * 3 + 2] = (rng() - 0.5) * 0.06;

    // 散開位置：隨機球殼 + 一點往畫面外的偏移。
    const theta = rng() * TAU;
    const phi = Math.acos(2 * rng() - 1);
    const radius = 2.2 + rng() * 4.5;
    scatter[i * 3] = Math.sin(phi) * Math.cos(theta) * radius * 0.9;
    scatter[i * 3 + 1] = Math.cos(phi) * radius * 0.75;
    scatter[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius * 0.6 + 1.5;

    seeds[i] = rng();
    // 顏色漸層：依字的水平位置由 key 漸變到 accent，再加一點雜訊避免死板。
    const horizontal = clamp((px - minX) / spanX, 0, 1);
    mixes[i] = clamp(horizontal * 0.82 + rng() * 0.18, 0, 1);
  }

  return {
    position,
    scatter,
    seeds,
    mixes,
    aspect: spanX / spanY,
    pixels: cand,
    particleSize,
  };
}

// 建立一個「粒子文字物件」。
// 回傳 null 代表環境不支援（沒有 2D canvas / 文字太短），呼叫端要能接受沒有文字。
export function createParticleText({
  text,
  count = 1500,
  seed = 1,
  particleSize = 0.075,
  renderOrder = 10,
} = {}) {
  const sampled = sampleText(text, count, seed, particleSize);
  if (!sampled) return null;

  const { position, scatter, seeds, mixes, aspect } = sampled;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aMix', new THREE.BufferAttribute(mixes, 1));
  // 粒子會被 shader 移到散開位置（遠大於字的外框），自己給一個夠大的 bounding sphere，
  // 並且關掉 frustumCulled，避免鏡頭移動時整個文字被誤判成「不在畫面內」而消失。
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 20);

  const uniforms = {
    uTime: { value: 0 },
    uProgress: { value: 0 },
    uBurst: { value: 0 },
    uOpacity: { value: 1 },
    uScale: { value: 1 },
    uPointScale: { value: 960 }, // 由 index 依實際畫布高度更新
    uSize: { value: particleSize },
    uColorA: { value: new THREE.Color(0xffffff) },
    uColorB: { value: new THREE.Color(0xffffff) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLES_VERT,
    fragmentShader: PARTICLES_FRAG,
    transparent: true,
    depthWrite: false,
    // 歌詞/標題是「疊在畫面上的資訊層」，不能被旁邊掠過的建物或招牌切掉，
    // 所以關掉深度測試、用 renderOrder 排在最上層。
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = renderOrder;
  object.matrixAutoUpdate = true;

  let disposed = false;

  return {
    object,
    aspect,
    kind: 'text',
    // 給 index.js 判斷「這一句到底有沒有變」用：句子沒變就不重建，省掉重新取樣。
    sourceText: String(text == null ? '' : text),

    setVisible(visible) {
      object.visible = !!visible;
    },
    setTime(t) {
      uniforms.uTime.value = t;
    },
    setProgress(p) {
      uniforms.uProgress.value = clamp(p, 0, 1);
    },
    setBurst(b) {
      uniforms.uBurst.value = clamp(b, 0, 1);
    },
    setOpacity(o) {
      uniforms.uOpacity.value = clamp(o, 0, 1.2);
    },
    setScale(s) {
      const v = Math.max(0.0001, s);
      object.scale.setScalar(v);
      uniforms.uScale.value = v;
    },
    setPosition(x, y) {
      object.position.set(x, y, 0);
    },
    // 裝置像素換算：文字點大小需要知道「畫布高度 / 2」才能跟一般 Mesh 的視覺比例一致。
    setPointScale(px) {
      uniforms.uPointScale.value = Math.max(1, px);
    },
    setPalette(colorA, colorB) {
      if (colorA) uniforms.uColorA.value.copy(colorA);
      if (colorB) uniforms.uColorB.value.copy(colorB);
    },
    setParticleSize(size) {
      uniforms.uSize.value = Math.max(0.001, size);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (object.parent) object.parent.remove(object);
      try { geometry.dispose(); } catch { /* ignore */ }
      try { material.dispose(); } catch { /* ignore */ }
    },
  };
}
