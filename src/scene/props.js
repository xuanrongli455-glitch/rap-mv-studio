// rap-mv/src/scene/props.js — 黑膠唱片與麥克風。
//
// 兩者都是「卡在鏡頭航線旁邊」的世界座標道具：鏡頭沿 z 軸穿過街道時會近距離掠過，
// 因為有環境貼圖 + 高 metalness，擦身而過的瞬間會反光，這是整支 MV 最像「錢」的鏡頭之一。
// 旋轉與浮動全部是時間 t 的函式，錄影逐幀呼叫時結果一致。

import * as THREE from 'three';
import { TAU, clamp, createCanvas2D, num } from './util.js';

// 唱片溝紋：黑底 + 同心圓，中心留給標籤貼紙。
function makeGrooveTexture(rng) {
  const pair = createCanvas2D(512, 512);
  if (!pair) return null;
  const { ctx } = pair;
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, 512, 512);
  ctx.lineWidth = 1;
  // 密紋
  for (let r = 78; r < 250; r += 2.2) {
    const a = 0.05 + rng() * 0.1;
    ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(256, 256, r, 0, TAU);
    ctx.stroke();
  }
  // 幾道比較亮的主紋（模擬燈光打在唱片上的反光環）
  for (let i = 0; i < 7; i += 1) {
    const r = 90 + rng() * 150;
    ctx.strokeStyle = `rgba(255,255,255,${(0.18 + rng() * 0.22).toFixed(3)})`;
    ctx.lineWidth = 1.5 + rng() * 2;
    ctx.beginPath();
    ctx.arc(256, 256, r, rng() * TAU, rng() * TAU + 1.2 + rng() * 2);
    ctx.stroke();
  }
  // 中心標籤底（顏色之後由 material.color 染）
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.arc(256, 256, 74, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(256, 256, 74, 0, TAU);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(pair.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createProps({ rng, palette }) {
  const group = new THREE.Group();
  let pal = palette || {};

  const grooveTex = makeGrooveTexture(rng);

  // ── 共用資源（兩個唱片共用 geometry/material，省記憶體也省 draw 前的狀態切換）──
  const discGeo = new THREE.CylinderGeometry(2.0, 2.0, 0.12, 64, 1, false);
  const sideMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x14141c),
    metalness: 0.95,
    roughness: 0.3,
  });
  const grooveMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x1a1a24),
    metalness: 0.85,
    roughness: 0.34,
    map: grooveTex,
    emissive: new THREE.Color(pal.key || '#00e5ff'),
    emissiveMap: grooveTex,
    emissiveIntensity: 0.55,
  });
  const labelGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.03, 40, 1, false);
  const labelMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(pal.special || '#b14bff'),
    emissive: new THREE.Color(pal.special || '#b14bff'),
    emissiveIntensity: 0.85,
    metalness: 0.4,
    roughness: 0.45,
  });
  const rimGeo = new THREE.TorusGeometry(2.04, 0.035, 8, 72);
  const rimMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(pal.accent || '#ff2bd6').multiplyScalar(2),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  const headGeo = new THREE.SphereGeometry(0.55, 24, 16);
  const metalMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xc9d3e6),
    metalness: 1,
    roughness: 0.24,
  });
  const handleGeo = new THREE.CylinderGeometry(0.155, 0.105, 1.5, 18);
  const darkMetalMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x2b303c),
    metalness: 0.95,
    roughness: 0.34,
  });
  const grilleGeo = new THREE.TorusGeometry(0.5, 0.016, 6, 48);
  const accentMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(pal.accent || '#ff2bd6').multiplyScalar(1.9),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  // ── 建一個唱片實例（geometry / material 共用）──
  function buildVinyl() {
    const root = new THREE.Group();
    const spin = new THREE.Group();
    root.add(spin);

    const disc = new THREE.Mesh(discGeo, [sideMat, grooveMat, grooveMat]);
    disc.rotation.x = Math.PI / 2; // 圓盤軸對齊 z，正面朝鏡頭
    spin.add(disc);

    const label = new THREE.Mesh(labelGeo, labelMat);
    label.rotation.x = Math.PI / 2;
    label.position.z = 0.075;
    spin.add(label);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.z = 0.02;
    spin.add(rim);
    return { root, spin };
  }

  function buildMic() {
    const root = new THREE.Group();
    const spin = new THREE.Group();
    root.add(spin);

    const head = new THREE.Mesh(headGeo, metalMat);
    spin.add(head);

    // 麥克風網罩的橫向格柵：沿球面高度算環半徑
    for (let i = 0; i < 4; i += 1) {
      const y = -0.36 + i * 0.24;
      const r = Math.sqrt(Math.max(0.01, 0.55 * 0.55 - y * y)) + 0.004;
      const ring = new THREE.Mesh(grilleGeo, darkMetalMat);
      ring.scale.setScalar(r / 0.5);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      spin.add(ring);
    }

    const handle = new THREE.Mesh(handleGeo, darkMetalMat);
    handle.position.y = -1.05;
    spin.add(handle);

    const collar = new THREE.Mesh(grilleGeo, accentMat);
    collar.scale.setScalar(0.36 / 0.5);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = -0.62;
    spin.add(collar);

    const halo = new THREE.Mesh(rimGeo, accentMat);
    halo.scale.setScalar(0.33);
    halo.position.y = 0.0;
    halo.rotation.x = 0;
    spin.add(halo);

    return { root, spin };
  }

  // ── 擺放：沿街道兩側的航線旁，鏡頭會一一掠過 ──
  const vinyls = [];
  const mics = [];

  const vinylDefs = [
    { x: 5.2, y: 5.4, z: -34, ry: -0.5, rx: -0.12, s: 1.0, phase: 0 },
    { x: 4.9, y: 4.5, z: -104, ry: -0.34, rx: 0.1, s: 0.78, phase: 2.1 },
  ];
  for (const def of vinylDefs) {
    const v = buildVinyl();
    v.root.position.set(def.x, def.y, def.z);
    v.root.rotation.set(def.rx, def.ry, 0.12);
    v.root.scale.setScalar(def.s);
    v.baseY = def.y;
    v.baseScale = def.s;
    v.phase = def.phase;
    v.spinSpeed = 2.0;
    group.add(v.root);
    vinyls.push(v);
  }

  const micDefs = [
    { x: -5.2, y: 6.1, z: -70, ry: 0.5, rz: 0.55, s: 1.05, phase: 0.7 },
    { x: -5.0, y: 6.8, z: -150, ry: 0.2, rz: -0.4, s: 1.15, phase: 3.4 },
  ];
  for (const def of micDefs) {
    const m = buildMic();
    m.root.position.set(def.x, def.y, def.z);
    m.root.rotation.set(0, def.ry, def.rz);
    m.root.scale.setScalar(def.s);
    m.baseY = def.y;
    m.baseScale = def.s;
    m.phase = def.phase;
    group.add(m.root);
    mics.push(m);
  }

  let vinylVisible = true;
  let micVisible = true;

  function setVisible({ vinyl, mic }) {
    if (typeof vinyl === 'boolean') vinylVisible = vinyl;
    if (typeof mic === 'boolean') micVisible = mic;
    for (const v of vinyls) v.root.visible = vinylVisible;
    for (const m of mics) m.root.visible = micVisible;
  }

  function update(t, stats) {
    const time = num(t, 0);
    const beat = clamp(num(stats && stats.beat, 0), 0, 1);
    const pulse = 1 + beat * 0.05;

    for (const v of vinyls) {
      if (!v.root.visible) continue;
      // 33⅓ rpm ≈ 3.49 rad/s；放慢成 2.0 更有夢境感
      v.spin.rotation.z = time * v.spinSpeed + v.phase;
      v.root.position.y = v.baseY + Math.sin(time * 0.85 + v.phase) * 0.32;
      // 節拍時微微放大，像喇叭的低頻在推它
      v.root.scale.setScalar(v.baseScale * pulse);
    }

    for (const m of mics) {
      if (!m.root.visible) continue;
      m.spin.rotation.y = time * 0.55 + m.phase;
      m.root.position.y = m.baseY + Math.sin(time * 1.1 + m.phase) * 0.28;
      m.root.scale.setScalar(m.baseScale * pulse);
    }
  }

  function setPalette(next) {
    if (!next) return;
    pal = next;
    grooveMat.emissive.set(pal.key);
    labelMat.color.set(pal.special);
    labelMat.emissive.set(pal.special);
    rimMat.color.set(pal.accent).multiplyScalar(2);
    accentMat.color.set(pal.accent).multiplyScalar(1.9);
  }

  return {
    group,
    setPalette,
    update,
    setVisible,
    dispose() {
      grooveTex && grooveTex.dispose();
      discGeo.dispose();
      sideMat.dispose();
      grooveMat.dispose();
      labelGeo.dispose();
      labelMat.dispose();
      rimGeo.dispose();
      rimMat.dispose();
      headGeo.dispose();
      metalMat.dispose();
      handleGeo.dispose();
      darkMetalMat.dispose();
      grilleGeo.dispose();
      accentMat.dispose();
    },
  };
}
