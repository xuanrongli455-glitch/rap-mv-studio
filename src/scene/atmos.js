// rap-mv/src/scene/atmos.js — 大氣層：天空、雨、漂浮塵埃、節拍震波。
//
// 全部跟著鏡頭跑（天空球、雨、塵埃都只改 group.position），
// 所以不管鏡頭飛到城市哪一端，畫面都不會出現「雨下完了」的空窗。
// 雨的垂直循環用「兩層粒子 + group.y 取 mod」達成，是純時間函式，不需要逐粒更新。

import * as THREE from 'three';
import { TAU, clamp, createCanvas2D, mod, num } from './util.js';

// ── 貼圖 ──
function makeSkyTexture(pal, rng) {
  const pair = createCanvas2D(16, 512);
  if (!pair) return null;
  const { ctx } = pair;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  // canvas 上方 = 天頂、中間 = 地平線、下方 = 地面（實際會被地面擋住）
  g.addColorStop(0, pal.bg);
  g.addColorStop(0.34, pal.bg);
  g.addColorStop(0.44, pal.fog);
  g.addColorStop(0.475, pal.fog);
  g.addColorStop(0.5, mixHex(pal.fog, pal.key, 0.34));
  g.addColorStop(0.525, pal.fog);
  g.addColorStop(0.62, mixHex(pal.fog, pal.ground, 0.7));
  g.addColorStop(1, pal.ground);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);

  // 地平線上一點城市光暈的雜訊，避免漸層太乾淨
  for (let i = 0; i < 60; i += 1) {
    const y = 220 + rng() * 80;
    ctx.fillStyle = `rgba(255,255,255,${(0.02 + rng() * 0.04).toFixed(3)})`;
    ctx.fillRect(0, y, 16, 1 + rng() * 2);
  }

  const tex = new THREE.CanvasTexture(pair.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// 只給「程序化貼圖」用的簡單 sRGB 混合（這裡不 import three 的 Color，避免和材質色彩空間混淆）
function mixHex(a, b, t) {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function parseHex(hex) {
  const s = String(hex || '#000000').replace('#', '');
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(v.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeStreakTexture() {
  const pair = createCanvas2D(16, 64);
  if (!pair) return null;
  const { ctx } = pair;
  ctx.clearRect(0, 0, 16, 64);
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(6, 0, 4, 64);
  const tex = new THREE.CanvasTexture(pair.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDustTexture() {
  const pair = createCanvas2D(64, 64);
  if (!pair) return null;
  const { ctx } = pair;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(pair.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── 本體 ──
export function createAtmosphere({ rng, palette }) {
  const group = new THREE.Group();
  let pal = palette || {};

  // 天空球：跟著鏡頭水平移動，永遠包住鏡頭；地平線那圈亮帶是城市光害。
  const skyGeo = new THREE.SphereGeometry(300, 24, 16);
  const skyMat = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  group.add(sky);

  let skyTex = null;
  function rebuildSky() {
    if (skyTex) {
      skyMat.map = null;
      skyMat.needsUpdate = true;
      try { skyTex.dispose(); } catch { /* ignore */ }
    }
    skyTex = makeSkyTexture(pal, rng);
    if (skyTex) {
      skyMat.map = skyTex;
      skyMat.needsUpdate = true;
    }
  }
  rebuildSky();

  // ── 雨 ──
  const RAIN_COUNT = 1500;
  const RAIN_TILE = 46;
  const rainPositions = new Float32Array(RAIN_COUNT * 2 * 3);
  for (let i = 0; i < RAIN_COUNT; i += 1) {
    const x = (rng() - 0.5) * 70;
    const z = (rng() - 0.5) * 70;
    const y = rng() * RAIN_TILE;
    const o = i * 6;
    rainPositions[o] = x;
    rainPositions[o + 1] = y;
    rainPositions[o + 2] = z;
    // 第二份往上平移一個 tile 高度，配合 group.y = -mod(t*speed, tile) 形成無縫循環
    rainPositions[o + 3] = x;
    rainPositions[o + 4] = y + RAIN_TILE;
    rainPositions[o + 5] = z;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const rainTex = makeStreakTexture();
  const rainMat = new THREE.PointsMaterial({
    color: new THREE.Color(pal.key || '#00e5ff'),
    size: 0.22,
    map: rainTex,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });
  const rain = new THREE.Points(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.rotation.x = 0.12; // 斜雨，暗示風向
  rain.rotation.z = 0.05;
  const rainGroup = new THREE.Group();
  rainGroup.add(rain);
  group.add(rainGroup);

  // ── 漂浮塵埃 ──
  const DUST_COUNT = 700;
  const dustPositions = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < DUST_COUNT; i += 1) {
    dustPositions[i * 3] = (rng() - 0.5) * 60;
    dustPositions[i * 3 + 1] = rng() * 22;
    dustPositions[i * 3 + 2] = (rng() - 0.5) * 60;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dustTex = makeDustTexture();
  const dustMat = new THREE.PointsMaterial({
    color: new THREE.Color(pal.special || '#b14bff'),
    size: 0.12,
    map: dustTex,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  const dustGroup = new THREE.Group();
  dustGroup.add(dust);
  group.add(dustGroup);

  // ── 節拍震波（貼在地面的光圈）──
  const ringGeo = new THREE.RingGeometry(0.93, 1.0, 64, 1);
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(pal.key || '#00e5ff').multiplyScalar(1.35),
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.renderOrder = 3;
  group.add(ring);

  let rainVisible = true;
  let particlesVisible = true;

  function setVisible({ rain: showRain, particles }) {
    if (typeof showRain === 'boolean') rainVisible = showRain;
    if (typeof particles === 'boolean') particlesVisible = particles;
    rainGroup.visible = rainVisible;
    dustGroup.visible = particlesVisible;
    ring.visible = particlesVisible;
  }

  function update(t, camera, stats) {
    const time = num(t, 0);
    const beat = clamp(num(stats && stats.beat, 0), 0, 1);
    const camX = camera ? camera.position.x : 0;
    const camY = camera ? camera.position.y : 3.6;
    const camZ = camera ? camera.position.z : 0;

    // 天空球只跟水平位移，地平線高度才不會隨鏡頭升降跑掉
    sky.position.set(camX, 0, camZ);

    // 雨：垂直循環 + 貼著鏡頭
    rainGroup.position.set(camX, -mod(time * 26, RAIN_TILE) + 0.5, camZ);
    rain.rotation.z = 0.05 + Math.sin(time * 0.4) * 0.02;

    // 塵埃：慢慢旋轉、跟著鏡頭
    dustGroup.position.set(camX, 0, camZ);
    dustGroup.rotation.y = time * 0.035;
    dustGroup.position.y = camY * 0.2 + Math.sin(time * 0.35) * 0.4;
    dust.rotation.z = Math.sin(time * 0.2) * 0.06;

    // 震波：每次重拍往外擴，透明度隨包絡衰減。
    // 環心必須在「鏡頭正下方」，這樣看到的是地面上一個往外擴的圓，
    // 而不是一道貼在鏡頭前、被 bloom 糊成白光的巨大圓弧。
    const s = 1.5 + beat * 14;
    ring.scale.setScalar(s);
    ringMat.opacity = beat * beat * 0.3;
    ring.position.set(camX, 0.06, camZ);
  }

  function setPalette(next) {
    if (!next) return;
    pal = next;
    rainMat.color.set(pal.key);
    dustMat.color.set(pal.special);
    ringMat.color.set(pal.key).multiplyScalar(1.35);
    rebuildSky();
  }

  return {
    group,
    setPalette,
    update,
    setVisible,
    dispose() {
      skyTex && skyTex.dispose();
      rainTex && rainTex.dispose();
      dustTex && dustTex.dispose();
      skyGeo.dispose();
      skyMat.dispose();
      rainGeo.dispose();
      rainMat.dispose();
      dustGeo.dispose();
      dustMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
    },
  };
}
