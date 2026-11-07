// rap-mv/src/scene/city.js — 霓虹賽博城市。
//
// 構成：
//  • 濕地平面：高 metalness + 場景環境貼圖（由 index.js 的 PMREM 提供）製造濕亮反光，
//    再疊一張程序化網格貼圖當 emissiveMap，讓街道像發光的電路板。
//  • 樓宇：一個 InstancedMesh 裝 100+ 棟低模方塊。窗戶不是貼圖，而是在
//    MeshStandardMaterial 的 fragment shader 裡用「世界座標 + 每棟種子」程序化生成，
//    這樣窗格大小不會被 instance 縮放拉扁，也不會每棟長一樣（貼圖做不到）。
//  • 霓虹：亮到 HDR 的 MeshBasicMaterial 平面/燈管，交給 UnrealBloomPass 開花。
//  • 全息看板：程序化白色塗鴉貼圖 + AdditiveBlending，換 palette 只改 material.color。

import * as THREE from 'three';
import { TAU, clamp, createCanvas2D } from './util.js';

// ── 程序化貼圖 ──

// 濕地網格：白色線條畫在黑底上。當 emissiveMap 用時「只有線會發光」，底色不發光。
function makeGridTexture(rng) {
  const pair = createCanvas2D(512, 512);
  if (!pair) return null;
  const { ctx } = pair;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 512, 512);

  // 細網格
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 512; i += 32) {
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, 512);
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(512, i + 0.5);
  }
  ctx.stroke();

  // 每 4 格一條主幹線，街道尺度更清楚
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 512; i += 128) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
  }
  ctx.stroke();

  // 濕地的不規則反光條（雨後積水的高光碎片）
  for (let i = 0; i < 130; i += 1) {
    const x = rng() * 512;
    const y = rng() * 512;
    const w = 8 + rng() * 90;
    const h = 1 + rng() * 3;
    ctx.fillStyle = `rgba(255,255,255,${(0.05 + rng() * 0.16).toFixed(3)})`;
    ctx.fillRect(x, y, w, h);
  }

  const tex = new THREE.CanvasTexture(pair.canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 全息看板的「假廣告」：白線塗鴉畫在黑底，用 additive 疊上去。
function makeGlyphTexture(rng) {
  const pair = createCanvas2D(512, 256);
  if (!pair) return null;
  const { ctx } = pair;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'round';

  for (let i = 0; i < 14; i += 1) {
    const x = rng() * 512;
    const y = rng() * 256;
    const s = 12 + rng() * 54;
    ctx.globalAlpha = 0.35 + rng() * 0.65;
    ctx.lineWidth = 2 + rng() * 5;
    const kind = rng();
    if (kind < 0.36) {
      ctx.beginPath();
      ctx.arc(x, y, s, 0, TAU);
      ctx.stroke();
    } else if (kind < 0.62) {
      ctx.strokeRect(x - s * 0.5, y - s * 0.6, s * 1.6, s * 0.9);
    } else if (kind < 0.82) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + s * 1.8, y - s * 0.8);
      ctx.moveTo(x, y + s * 0.4);
      ctx.lineTo(x + s * 1.4, y + s * 0.9);
      ctx.stroke();
    } else {
      // 假文字：一排粗細不一的直條
      const bars = 4 + Math.floor(rng() * 5);
      for (let b = 0; b < bars; b += 1) {
        ctx.globalAlpha = 0.3 + rng() * 0.7;
        ctx.fillRect(x + b * 9, y, 5, s);
      }
    }
  }
  // 幾條貫穿畫面的掃描線，讓它看起來像故障的電子看板
  ctx.globalAlpha = 0.28;
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(0, rng() * 256, 512, 1 + rng() * 2);
  }

  const tex = new THREE.CanvasTexture(pair.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ── 樓宇窗戶材質 ──
// 這裡是整座城市「一看就是錢」的關鍵：程序化窗格在 fragment shader 裡算，
// 用世界座標當格線座標，所以 instance 被拉高拉寬都不會變形；
// 每棟樓再用 aSeed 位移，窗戶不會整齊排成同一張貼圖。
function createWindowMaterial(pal) {
  const uniforms = {
    uWinA: { value: new THREE.Color(pal.key) },
    uWinB: { value: new THREE.Color(pal.accent) },
    uWinC: { value: new THREE.Color(pal.special) },
    uWinIntensity: { value: 1 },
    uWinTime: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({
    // 白 ⇒ instanceColor 直接等於牆面 albedo；實際亮度由實例色控制（見 WALL_ALBEDO）
    color: new THREE.Color(0xffffff),
    roughness: 0.68,
    metalness: 0.45,
  });

  material.userData.windowUniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWinA = uniforms.uWinA;
    shader.uniforms.uWinB = uniforms.uWinB;
    shader.uniforms.uWinC = uniforms.uWinC;
    shader.uniforms.uWinIntensity = uniforms.uWinIntensity;
    shader.uniforms.uWinTime = uniforms.uWinTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aSeed;
        varying vec3 vWPos;
        varying vec3 vObjN;
        varying float vSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSeed = aSeed;
        vObjN = normal;
        #ifdef USE_INSTANCING
          vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uWinA;
        uniform vec3 uWinB;
        uniform vec3 uWinC;
        uniform float uWinIntensity;
        uniform float uWinTime;
        varying vec3 vWPos;
        varying vec3 vObjN;
        varying float vSeed;
        float winHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 wn = normalize(vObjN);
          // 只有垂直面（非屋頂）有窗戶
          float side = 1.0 - step(0.55, abs(wn.y));
          // 依法線決定用 x 還是 z 當水平座標，四面牆的窗格才會等寬
          float useX = step(0.5, abs(wn.x));
          float u = mix(vWPos.z, vWPos.x, useX);
          // 每棟樓的樓層高度略有不同
          float cellY = mix(2.8, 4.2, fract(vSeed * 7.13));
          vec2 grid = vec2(u / 2.35, vWPos.y / cellY);
          vec2 id = floor(grid);
          vec2 f = fract(grid);
          // 窗戶本體（格子內縮）
          float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.24, f.y) * step(f.y, 0.74);
          float lit = step(0.44, winHash(id + vSeed * 17.0));
          float tone = winHash(id * 1.7 + vSeed * 3.1);
          vec3 wc = mix(uWinA, uWinB, step(0.74, tone));
          wc = mix(wc, uWinC, step(0.94, tone));
          // 少數窗戶會閃（電視機/故障燈）
          float flicker = 0.84 + 0.16 * sin(uWinTime * 2.7 + tone * 63.0);
          // 低樓層比較亮（騎樓、店面），高樓層稀薄
          float low = smoothstep(1.5, 9.0, vWPos.y);
          float amount = win * lit * side * uWinIntensity * flicker * (0.5 + low * 0.9);
          vec3 em = wc * amount;
          // 牆面極淡的環境反射，避免整棟死黑
          em += uWinC * side * 0.012;
          totalEmissiveRadiance += em;
        }`,
      );
  };
  // 每份材質要有自己的 program 快取鍵，否則 three 會把 onBeforeCompile 只跑一次、
  // 之後的材質共用同一份 uniform 參照（換主題色時會有一半物件不變色）。
  material.customProgramCacheKey = () => 'rapmv-city-windows-v1';

  return material;
}

function makeInstanceColorArray(mesh, colors) {
  for (let i = 0; i < colors.length; i += 1) {
    mesh.setColorAt(i, colors[i]);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// ── 城市本體 ──
export function createCity({ rng, palette }) {
  const group = new THREE.Group();
  let pal = palette || {};
  const dummy = new THREE.Object3D();

  const gridTex = makeGridTexture(rng);

  // ── 濕地平面 ──
  // 重點：不要用 gridTex 當 map。金屬/濕地的反射是被 albedo 染色的，
  // 一旦 albedo 被黑色網格貼圖壓成 0，整片地面就完全沒有反光。
  // 所以 albedo 保持單純的深色，網格只走 emissiveMap（只有線條發光），
  // 再靠低 roughness + 環境貼圖在「掠射角」產生霓虹反光。
  const groundMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(pal.ground).multiplyScalar(3.0),
    roughness: 0.16,
    metalness: 0.2,
    emissive: new THREE.Color(pal.key),
    emissiveMap: gridTex,
    emissiveIntensity: 0.75,
    envMapIntensity: 1.7,
  });
  const groundGeo = new THREE.PlaneGeometry(620, 620, 1, 1);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  group.add(ground);

  // ── 樓宇 ──
  const buildings = [];
  // 主要街道兩側：z 從 +14 一路排到 -200
  for (let z = 14; z > -200; z -= 7.4) {
    for (const side of [-1, 1]) {
      if (rng() < 0.1) continue; // 留一些空地，天際線才有節奏
      const depth = 5 + rng() * 9;
      const width = 5 + rng() * 8;
      const height = 6 + Math.pow(rng(), 1.7) * 64;
      const x = side * (8.6 + width * 0.5 + rng() * 2.6);
      buildings.push({
        x,
        z: z - rng() * 3.2,
        w: width,
        d: depth,
        h: height,
        rot: (rng() - 0.5) * 0.24,
        seed: rng(),
      });
    }
  }
  // 第二排：更遠、更高，當天際線的背景層
  for (let i = 0; i < 64; i += 1) {
    const side = rng() < 0.5 ? -1 : 1;
    const width = 6 + rng() * 12;
    buildings.push({
      x: side * (20 + rng() * 34),
      z: 14 - rng() * 220,
      w: width,
      d: 6 + rng() * 12,
      h: 12 + Math.pow(rng(), 1.3) * 85,
      rot: (rng() - 0.5) * 0.3,
      seed: rng(),
    });
  }

  // palette.ground 本身非常暗（線性值 ~0.003），直接當 albedo 會讓牆面全黑。
  // 放大 7.5 倍後大約是 0.02~0.06 的深藍灰，足以被霓虹燈與環境貼圖照亮但不會搶走窗戶的戲。
  const WALL_ALBEDO = 7.5;

  const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
  buildingGeo.translate(0, 0.5, 0); // 讓 y=0 是地面
  const seedAttr = new Float32Array(buildings.length);
  const buildingColors = [];
  const buildingTints = new Float32Array(buildings.length);
  for (let i = 0; i < buildings.length; i += 1) {
    const b = buildings[i];
    seedAttr[i] = b.seed;
    buildingTints[i] = 0.55 + rng() * 0.9;
    buildingColors.push(
      new THREE.Color(pal.ground).multiplyScalar(WALL_ALBEDO * buildingTints[i]),
    );
  }
  buildingGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedAttr, 1));

  const windowMaterial = createWindowMaterial(pal);
  const buildingMesh = new THREE.InstancedMesh(buildingGeo, windowMaterial, buildings.length);
  buildingMesh.frustumCulled = false; // 城市幾乎永遠在畫面裡，省掉包圍球計算
  for (let i = 0; i < buildings.length; i += 1) {
    const b = buildings[i];
    dummy.position.set(b.x, 0, b.z);
    dummy.rotation.set(0, b.rot, 0);
    dummy.scale.set(b.w, b.h, b.d);
    dummy.updateMatrix();
    buildingMesh.setMatrixAt(i, dummy.matrix);
  }
  buildingMesh.instanceMatrix.needsUpdate = true;
  makeInstanceColorArray(buildingMesh, buildingColors);
  group.add(buildingMesh);

  // ── 霓虹燈管 / 屋頂燈條 ──
  // 用一個 InstancedMesh 裝所有細長燈管：屋頂橫條、牆角直管、街邊光條都只是不同縮放。
  const stripDefs = [];
  for (let i = 0; i < buildings.length; i += 1) {
    const b = buildings[i];
    if (Math.abs(b.x) > 42) continue;
    if (rng() < 0.55) continue;
    const faceX = b.x > 0 ? b.x - b.w * 0.5 - 0.12 : b.x + b.w * 0.5 + 0.12;
    const c = ['key', 'accent', 'special'][Math.floor(rng() * 3)];
    if (rng() < 0.62) {
      // 屋頂橫條
      stripDefs.push({
        x: faceX,
        y: b.h + 0.15,
        z: b.z,
        sx: 0.16,
        sy: 0.16,
        sz: b.d * 0.8,
        c,
        f: 1.0 + rng() * 1.0,
      });
    } else {
      // 牆角垂直燈管
      stripDefs.push({
        x: faceX,
        y: b.h * 0.5,
        z: b.z + b.d * 0.5 - 0.4,
        sx: 0.13,
        sy: b.h * (0.5 + rng() * 0.45),
        sz: 0.13,
        c,
        f: 1.0 + rng() * 1.1,
      });
    }
  }
  // 街道邊緣的光條：貼地 2.4 公尺高，強化「街道」的透視收斂
  for (let z = 12; z > -200; z -= 9) {
    for (const side of [-1, 1]) {
      stripDefs.push({
        x: side * 7.7,
        y: 2.3,
        z: z - 2,
        sx: 0.1,
        sy: 0.1,
        sz: 5.5,
        c: side < 0 ? 'key' : 'accent',
        f: 0.9 + rng() * 0.6,
      });
    }
  }

  const stripGeo = new THREE.BoxGeometry(1, 1, 1);
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const stripMesh = new THREE.InstancedMesh(stripGeo, stripMat, stripDefs.length);
  stripMesh.frustumCulled = false;
  const stripColors = [];
  for (let i = 0; i < stripDefs.length; i += 1) {
    const s = stripDefs[i];
    dummy.position.set(s.x, s.y, s.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(s.sx, s.sy, s.sz);
    dummy.updateMatrix();
    stripMesh.setMatrixAt(i, dummy.matrix);
    stripColors.push(new THREE.Color(pal[s.c]).multiplyScalar(s.f));
  }
  stripMesh.instanceMatrix.needsUpdate = true;
  makeInstanceColorArray(stripMesh, stripColors);
  group.add(stripMesh);

  // ── 霓虹招牌 ──
  const signDefs = [];
  // 掛在樓面上的「刀牌」：從牆面往街道突出、面朝街道前後方向（±z）。
  // 這一點很重要：如果招牌平貼牆面（法線朝 ±x），鏡頭沿街道飛過去時只會看到一條邊，
  // 幾乎等於不存在；突出且面向 z 軸才會一路在畫面兩側發光。
  for (let i = 0; i < 58; i += 1) {
    const b = buildings[Math.floor(rng() * buildings.length)];
    if (Math.abs(b.x) > 34) continue;
    const side = b.x > 0 ? 1 : -1;
    const sx = 1.2 + rng() * 1.8;
    const sy = 0.8 + rng() * 3.0;
    const faceX = b.x - side * (b.w * 0.5 + 0.2);
    signDefs.push({
      x: faceX - side * sx * 0.5,
      y: 3 + rng() * Math.min(Math.max(1, b.h - 3), 26),
      z: b.z + (rng() - 0.5) * Math.max(1, b.d * 0.6),
      rotY: (rng() - 0.5) * 0.6,
      sx,
      sy,
      c: ['key', 'accent', 'special'][Math.floor(rng() * 3)],
      f: 1.25 + rng() * 1.2,
    });
  }
  // 橫跨街道的吊掛招牌（穿越鏡頭時最有速度感）
  for (let i = 0; i < 14; i += 1) {
    const z = -6 - rng() * 170;
    signDefs.push({
      x: (rng() - 0.5) * 7,
      y: 7 + rng() * 8,
      z,
      rotY: (rng() - 0.5) * 0.3,
      sx: 2.6 + rng() * 4.5,
      sy: 1.1 + rng() * 1.8,
      c: ['key', 'accent', 'special'][Math.floor(rng() * 3)],
      f: 1.3 + rng() * 1.1,
    });
  }

  const signGeo = new THREE.PlaneGeometry(1, 1);
  const signMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const signMesh = new THREE.InstancedMesh(signGeo, signMat, signDefs.length);
  signMesh.frustumCulled = false;
  const signColors = [];
  for (let i = 0; i < signDefs.length; i += 1) {
    const s = signDefs[i];
    dummy.position.set(s.x, s.y, s.z);
    dummy.rotation.set(0, s.rotY, 0);
    dummy.scale.set(s.sx, s.sy, 1);
    dummy.updateMatrix();
    signMesh.setMatrixAt(i, dummy.matrix);
    signColors.push(new THREE.Color(pal[s.c]).multiplyScalar(s.f));
  }
  signMesh.instanceMatrix.needsUpdate = true;
  makeInstanceColorArray(signMesh, signColors);
  group.add(signMesh);

  // ── 全息看板 ──
  const glyphTex = makeGlyphTexture(rng);
  const glyphs = [];
  let glyphGeo = null;
  if (glyphTex) {
    // 45 度左右朝街道前方傾斜（不要平貼牆面，否則飛行時只剩一條邊）。
    const glyphDefs = [
      { x: 9.4, y: 16, z: -46, rotY: -0.55, sx: 9, sy: 4.5, c: 'accent' },
      { x: -9.6, y: 19, z: -88, rotY: 0.55, sx: 11, sy: 5.5, c: 'key' },
      { x: 10.5, y: 22, z: -146, rotY: -0.55, sx: 10, sy: 5, c: 'special' },
    ];
    glyphGeo = new THREE.PlaneGeometry(1, 1);
    for (const def of glyphDefs) {
      const mat = new THREE.MeshBasicMaterial({
        map: glyphTex,
        color: new THREE.Color(pal[def.c]).multiplyScalar(1.15),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(glyphGeo, mat);
      mesh.position.set(def.x, def.y, def.z);
      mesh.rotation.y = def.rotY;
      mesh.scale.set(def.sx, def.sy, 1);
      mesh.frustumCulled = false;
      group.add(mesh);
      // 保存「未脈動」的基底色，update() 每幀只做 copy + 乘係數，不配置新物件。
      glyphs.push({ mesh, mat, c: def.c, base: 1.15, baseColor: new THREE.Color(pal[def.c]) });
    }
  }

  // ── 更新與換色 ──
  // 注意：這裡每幀只改 uniform / material.color，不動任何 geometry 或 instanceColor；
  // instanceColor 只在 setPalette 時重算（那是使用者點主題色才會發生的事）。

  function applyPaletteColors() {
    const groundColor = new THREE.Color(pal.ground);
    for (let i = 0; i < buildings.length; i += 1) {
      buildingColors[i].copy(groundColor).multiplyScalar(WALL_ALBEDO * buildingTints[i]);
      buildingMesh.setColorAt(i, buildingColors[i]);
    }
    if (buildingMesh.instanceColor) buildingMesh.instanceColor.needsUpdate = true;

    for (let i = 0; i < stripDefs.length; i += 1) {
      stripColors[i].copy(new THREE.Color(pal[stripDefs[i].c])).multiplyScalar(stripDefs[i].f);
      stripMesh.setColorAt(i, stripColors[i]);
    }
    if (stripMesh.instanceColor) stripMesh.instanceColor.needsUpdate = true;

    for (let i = 0; i < signDefs.length; i += 1) {
      signColors[i].copy(new THREE.Color(pal[signDefs[i].c])).multiplyScalar(signDefs[i].f);
      signMesh.setColorAt(i, signColors[i]);
    }
    if (signMesh.instanceColor) signMesh.instanceColor.needsUpdate = true;
  }

  function setPalette(next) {
    if (!next) return;
    pal = next;
    groundMat.color.set(pal.ground).multiplyScalar(3.0);
    groundMat.emissive.set(pal.key);
    groundMat.emissiveIntensity = 0.75;
    const u = windowMaterial.userData.windowUniforms;
    u.uWinA.value.set(pal.key);
    u.uWinB.value.set(pal.accent);
    u.uWinC.value.set(pal.special);
    for (const g of glyphs) {
      g.baseColor.set(pal[g.c]);
      g.mat.color.copy(g.baseColor).multiplyScalar(g.base);
    }
    applyPaletteColors();
  }

  function update({ time = 0, beat = 0, bass = 0, mid = 0, treble = 0 } = {}) {
    const b = clamp(beat, 0, 1);
    const lo = clamp(bass, 0, 1);
    const hi = clamp(treble, 0, 1);

    // 窗戶亮度：重拍時整座城市「亮起來」，低頻讓它持續發光。
    const u = windowMaterial.userData.windowUniforms;
    u.uWinTime.value = time;
    u.uWinIntensity.value = 0.8 + b * 0.8 + lo * 0.25;

    groundMat.emissiveIntensity = 0.6 + b * 0.5 + lo * 0.25;

    // 招牌與燈管整體提亮：instanceColor 已經帶色，material.color 當「總亮度」乘數。
    const glow = 1.0 + b * 0.55 + hi * 0.15;
    signMat.color.setScalar(glow);
    stripMat.color.setScalar(glow * 0.95);

    for (const g of glyphs) {
      g.mat.color.copy(g.baseColor).multiplyScalar(g.base * (0.9 + b * 0.5));
    }
  }

  return {
    group,
    setPalette,
    update,
    // 只切換「城市建物/霓虹」，地面（濕地反射）永遠留著，
    // 因為黑膠/麥克風/雨都需要一個能反光的地面，關掉城市才不會變成漂浮物。
    setVisible(show) {
      const v = show !== false;
      buildingMesh.visible = v;
      stripMesh.visible = v;
      signMesh.visible = v;
      for (const g of glyphs) g.mesh.visible = v;
    },
    get windowUniforms() {
      return windowMaterial.userData.windowUniforms;
    },
    dispose() {
      gridTex && gridTex.dispose();
      glyphTex && glyphTex.dispose();
      buildingGeo.dispose();
      windowMaterial.dispose();
      stripGeo.dispose();
      stripMat.dispose();
      signGeo.dispose();
      signMat.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      if (glyphGeo) glyphGeo.dispose();
      for (const g of glyphs) g.mat.dispose();
      // 註：index.js 另外會呼叫 disposeObject3D(scene) 兜底，這裡還是把自己的資源清乾淨。
    },
  };
}
