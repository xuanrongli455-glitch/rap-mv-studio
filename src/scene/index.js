// rap-mv/src/scene/index.js — 3D 場景的整合層（合約 A 段實作）。
//
// 這裡負責「把 config 翻譯成畫面」：
//   1. 建立 renderer / scene / camera / 燈光 / 環境貼圖（全部在這個函式內，模組頂層不建資源）
//   2. 組裝 city / props / atmos / text 等子模組
//   3. update(t, stats)：純時間函式，算出鏡頭、文字時序、節拍反應，交給各子模組
//   4. setConfig / resize / render / dispose / info
//
// 分鏡時間表在 camera.js；文字粒子在 text.js；其餘視覺元件各自一檔。

import * as THREE from 'three';
import { PALETTES, defaultConfig } from '../config.js';
import {
  clamp,
  createLogger,
  disposeObject3D,
  easeOutBack,
  hashString,
  mulberry32,
  num,
  smoothstep,
} from './util.js';
import { cameraPath, fovForAspect, getTimeline, lyricState } from './camera.js';
import { createParticleText } from './text.js';
import { createCity } from './city.js';
import { createProps } from './props.js';
import { createAtmosphere } from './atmos.js';
import { createPost } from './post.js';
import { createParticlePortrait } from './portrait.js';
import { createAvatar } from './avatar.js';

// 固定種子：場景的「亂數」全部由此展開，播放時才不會每次長得不一樣。
const SEED = 20241107;
// 文字距鏡頭的世界距離（文字是相機的子物件，所以永遠固定在螢幕這個位置）
const TEXT_DIST = 7;
const MAX_PIXEL_RATIO = 2;
// 畫布總像素上限：超過就用 pixelRatio = 1。
// 我們把 canvas 內部解析度當成「輸出影片解析度」（main.js 設 1080×1920），
// 所以預設不放大，避免錄出 2160×3840 的影片讓 iPhone 編碼跟不上。
const MAX_DRAWING_PIXELS = 3.0e6;
const FOG_DENSITY = 0.0092;

// 各種文字的角色設定：數量、粒子大小（相對於文字高度）、畫面佔比。
// 粒子大小是「文字高度的比例」，實際像素大小再乘上鏡頭距離換算。
const TEXT_SPECS = {
  title: { count: 2200, particleSize: 0.055, hFrac: 0.2, wFrac: 0.86, renderOrder: 20 },
  tagline: { count: 900, particleSize: 0.115, hFrac: 0.055, wFrac: 0.44, renderOrder: 21 },
  lyric: { count: 1700, particleSize: 0.09, hFrac: 0.13, wFrac: 0.88, renderOrder: 15 },
  artist: { count: 3000, particleSize: 0.05, hFrac: 0.34, wFrac: 0.92, renderOrder: 22 },
  cta: { count: 1700, particleSize: 0.075, hFrac: 0.2, wFrac: 0.72, renderOrder: 23 },
  artistSmall: { count: 900, particleSize: 0.105, hFrac: 0.08, wFrac: 0.62, renderOrder: 24 },
};

function emptyContent() {
  // 子系統建立失敗時的降級替身：畫面少了那個元素，但整支 App 不會白屏。
  return {
    group: new THREE.Group(),
    setPalette() {},
    update() {},
    setVisible() {},
    dispose() {},
  };
}

// config 正規化：UI 傳進來的任何欄位都可能缺、可能是字串，這裡一次補齊並夾好範圍。
function normalizeConfig(input) {
  const base = defaultConfig;
  const c = { ...base, ...(input || {}) };
  c.duration = clamp(num(c.duration, base.duration), 1, 600);
  c.fps = Math.round(clamp(num(c.fps, base.fps), 10, 60));
  c.bpm = clamp(num(c.bpm, base.bpm), 30, 240);
  c.intensity = clamp(num(c.intensity, base.intensity), 0, 1);
  c.shake = clamp(num(c.shake, base.shake), 0, 1);
  c.bloom = clamp(num(c.bloom, base.bloom), 0, 3);
  c.grain = clamp(num(c.grain, base.grain), 0, 1);
  c.title = String(c.title == null ? '' : c.title);
  c.artist = String(c.artist == null ? '' : c.artist);
  c.tagline = String(c.tagline == null ? '' : c.tagline);
  c.cta = String(c.cta == null ? '' : c.cta);
  // 顏色覆寫：只收 #rgb / #rrggbb / #rrggbbaa，格式不對就當作「跟隨配色」
  const colorOr = (v) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(v || '')) ? String(v) : '');
  c.lyricColor = colorOr(c.lyricColor);
  c.titleColor = colorOr(c.titleColor);
  if (!PALETTES[c.palette]) c.palette = 'neon';
  for (const key of ['showCity', 'showVinyl', 'showMic', 'showParticles', 'showLyrics', 'showRain']) {
    c[key] = c[key] !== false;
  }
  c.showPortrait = c.showPortrait !== false;
  c.showAvatar = c.showAvatar !== false;
  c.lyrics = Array.isArray(c.lyrics)
    ? c.lyrics
        .filter((line) => line && typeof line.text === 'string')
        .map((line) => ({
          text: line.text,
          t0: num(line.t0, 0),
          t1: num(line.t1, num(line.t0, 0) + 1),
        }))
    : [];
  return c;
}

// 只用「文字內容」當重建依據：改 t0/t1（時間）不需要重新取樣粒子，
// 時間是 update() 每幀從 cfg.lyrics 直接讀的。
function lyricTextSignature(lyrics) {
  return (lyrics || []).map((l) => l.text).join('\u0002');
}

export function createScene({ canvas, config } = {}) {
  if (!canvas) throw new Error('createScene: 必須提供 canvas');

  const warn = createLogger();
  let cfg = normalizeConfig(config);
  let palette = PALETTES[cfg.palette] || PALETTES.neon;
  let disposed = false;
  let pointScale = 960; // gl_PointSize 換算用：畫布高度 / 2

  // ── Renderer ──
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // 有 bloom + 固定輸出解析度，省下 MSAA 的 GPU 成本
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    // main.js 的「存海報」是直接 canvas.toBlob()，沒有 preserveDrawingBuffer 會抓到黑畫面
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(new THREE.Color(palette.bg), 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  // composer 會 render 多次，autoReset 關掉才能統計到整串 pass 的 draw call
  renderer.info.autoReset = false;

  // ── Scene / Fog / Camera ──
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(palette.bg);
  scene.fog = new THREE.FogExp2(new THREE.Color(palette.fog), FOG_DENSITY);

  const camera = new THREE.PerspectiveCamera(61, 9 / 16, 0.1, 700);
  camera.position.set(0, 54, 76);
  scene.add(camera); // 粒子文字是相機的子物件，所以相機必須在場景圖裡

  // ── 燈光（只保留少量：iPhone 上每個燈都會加進所有 PBR 材質的 shader）──
  const hemi = new THREE.HemisphereLight(
    new THREE.Color(palette.key),
    new THREE.Color(palette.bg),
    0.42,
  );
  const dir = new THREE.DirectionalLight(new THREE.Color(palette.special), 0.7);
  dir.position.set(-24, 48, -20);
  const camLightA = new THREE.PointLight(new THREE.Color(palette.key), 60, 80, 2);
  const camLightB = new THREE.PointLight(new THREE.Color(palette.accent), 40, 110, 2);
  scene.add(hemi, dir, camLightA, camLightB);

  // ── 環境貼圖 ──
  // 把幾塊「霓虹光板」丟給 PMREMGenerator 烤成一張環境貼圖，地面與金屬道具才有
  // 濕亮、有顏色的反射。主題色換掉時要重烤（頻率很低：使用者點一下主題色才發生）。
  let envRT = null;
  function rebuildEnvironment() {
    try {
      if (envRT) {
        envRT.dispose();
        envRT = null;
      }
      const envScene = new THREE.Scene();
      envScene.background = new THREE.Color(palette.bg);
      const panels = [
        { c: palette.key, p: [0, 5, -22], s: [46, 8], m: 2.4 },
        { c: palette.accent, p: [-18, 3, -4], s: [30, 5], m: 2.2 },
        { c: palette.special, p: [18, 7, 2], s: [30, 5], m: 2.0 },
        { c: palette.fog, p: [0, 36, 0], s: [120, 60], m: 0.5 },
      ];
      const geos = [];
      const mats = [];
      for (const panel of panels) {
        const geo = new THREE.PlaneGeometry(panel.s[0], panel.s[1]);
        const mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(panel.c).multiplyScalar(panel.m),
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(panel.p[0], panel.p[1], panel.p[2]);
        mesh.lookAt(0, 0, 0);
        envScene.add(mesh);
        geos.push(geo);
        mats.push(mat);
      }
      const pmrem = new THREE.PMREMGenerator(renderer);
      envRT = pmrem.fromScene(envScene, 0.035, 0.1, 150);
      pmrem.dispose();
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.7;
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    } catch (err) {
      warn('環境貼圖建立失敗（改用純燈光）', err);
      scene.environment = null;
    }
  }
  rebuildEnvironment();

  // ── 內容子系統（任何一個失敗都降級成空物件，不拖垮整個 App）──
  let city;
  try {
    city = createCity({ rng: mulberry32(SEED ^ 0x1a2b3c), palette });
  } catch (err) {
    warn('城市建立失敗', err);
    city = emptyContent();
  }
  let props;
  try {
    props = createProps({ rng: mulberry32(SEED ^ 0x2b3c4d), palette });
  } catch (err) {
    warn('道具建立失敗', err);
    props = emptyContent();
  }
  let atmos;
  try {
    atmos = createAtmosphere({ rng: mulberry32(SEED ^ 0x3c4d5e), palette });
  } catch (err) {
    warn('大氣建立失敗', err);
    atmos = emptyContent();
  }
  scene.add(city.group, props.group, atmos.group);

  // ── 粒子文字 ──
  const textRoot = new THREE.Group();
  textRoot.position.set(0, 0, -TEXT_DIST);
  camera.add(textRoot);

  const texts = { title: null, tagline: null, artist: null, cta: null, artistSmall: null, lyrics: [] };
  let lyricsRebuilt = false;

  function buildTextObject(kind, sourceText) {
    const spec = TEXT_SPECS[kind];
    if (!spec) return null;
    let obj = null;
    try {
      obj = createParticleText({
        text: sourceText,
        count: spec.count,
        seed: (SEED ^ hashString(`${kind}|${String(sourceText)}`)) >>> 0,
        particleSize: spec.particleSize,
        renderOrder: spec.renderOrder,
      });
    } catch (err) {
      warn(`文字建立失敗（${kind}）`, err);
    }
    if (!obj) return null;
    obj.setPointScale(pointScale);
    obj.setVisible(false);
    textRoot.add(obj.object);
    return obj;
  }

  function replaceText(kind, sourceText) {
    const old = texts[kind];
    if (old) {
      try { old.dispose(); } catch { /* ignore */ }
    }
    texts[kind] = buildTextObject(kind, sourceText);
  }

  // 歌詞物件池同步：內容沒變的句子直接沿用物件，只重建真的改過的那一句。
  // 這樣使用者在 UI 打字時（每秒可能十幾次 setConfig）也只會重新取樣一行。
  function syncLyrics() {
    const lines = (cfg.lyrics || []).slice(0, 16);
    const next = new Array(lines.length);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const source = line && line.text ? line.text : '';
      const old = texts.lyrics[i];
      if (old && old.sourceText === source) {
        next[i] = old;
      } else {
        if (old) {
          try { old.dispose(); } catch { /* ignore */ }
        }
        next[i] = buildTextObject('lyric', source);
      }
    }
    // 句數變少：把多出來的物件釋放掉
    for (let i = lines.length; i < texts.lyrics.length; i += 1) {
      const old = texts.lyrics[i];
      if (old) {
        try { old.dispose(); } catch { /* ignore */ }
      }
    }
    texts.lyrics = next;
    lyricsRebuilt = true;
  }

  // 使用者自選顏色 → 由「一個顏色」推出深/淺兩階（粒子會混色，單色才不會看起來死板）
  function pairFrom(hex, lo = 1.0, hi = 1.45) {
    const base = new THREE.Color(hex);
    return [base.clone().multiplyScalar(lo), base.clone().multiplyScalar(hi)];
  }

  function applyTextColors() {
    const C = (key, mult) => new THREE.Color(palette[key] || '#ffffff').multiplyScalar(mult);
    const titlePair = cfg.titleColor ? pairFrom(cfg.titleColor, 1.0, 1.4) : null;
    const lyricPair = cfg.lyricColor ? pairFrom(cfg.lyricColor, 1.0, 1.35) : null;

    if (texts.title) texts.title.setPalette(titlePair ? titlePair[0] : C('text', 1.35), titlePair ? titlePair[1] : C('key', 1.5));
    if (texts.tagline) texts.tagline.setPalette(titlePair ? titlePair[0] : C('key', 1.15), titlePair ? titlePair[1] : C('accent', 1.15));
    if (texts.artist) texts.artist.setPalette(titlePair ? titlePair[0] : C('text', 1.45), titlePair ? titlePair[1] : C('accent', 1.5));
    if (texts.cta) texts.cta.setPalette(titlePair ? titlePair[1] : C('key', 1.5), titlePair ? titlePair[0] : C('text', 1.3));
    if (texts.artistSmall) texts.artistSmall.setPalette(titlePair ? titlePair[0] : C('text', 1.1), titlePair ? titlePair[1] : C('accent', 1.2));
    for (const obj of texts.lyrics) {
      if (!obj) continue;
      if (lyricPair) obj.setPalette(lyricPair[0], lyricPair[1]);
      else obj.setPalette(C('key', 1.3), C('accent', 1.35));
    }
  }

  function buildAllTexts() {
    replaceText('title', cfg.title);
    replaceText('tagline', cfg.tagline);
    replaceText('artist', cfg.artist);
    replaceText('cta', cfg.cta);
    replaceText('artistSmall', cfg.artist);
    syncLyrics();
    applyTextColors();
  }

  // ── 後處理（若 addon 或 shader 出錯，就退回直接 render）──
  let post = null;
  try {
    post = createPost({ renderer, scene, camera });
  } catch (err) {
    warn('後處理建立失敗（退回無 bloom 模式）', err);
    post = null;
  }

  // ── 可見性與主題 ──
  function applyVisibility() {
    try {
      city.setVisible(cfg.showCity !== false);
      props.setVisible({ vinyl: cfg.showVinyl !== false, mic: cfg.showMic !== false });
      atmos.setVisible({ rain: cfg.showRain !== false, particles: cfg.showParticles !== false });
      if (portrait) portrait.setVisible(cfg.showPortrait !== false);
      if (avatar) avatar.setVisible(cfg.showAvatar !== false);
    } catch (err) {
      warn('套用可見性失敗', err);
    }
  }

  function applyPalette() {
    try {
      scene.background.set(palette.bg);
      scene.fog.color.set(palette.fog);
      scene.fog.density = FOG_DENSITY;
      renderer.setClearColor(new THREE.Color(palette.bg), 1);
      hemi.color.set(palette.key);
      hemi.groundColor.set(palette.bg);
      dir.color.set(palette.special);
      camLightA.color.set(palette.key);
      camLightB.color.set(palette.accent);
      city.setPalette(palette);
      props.setPalette(palette);
      atmos.setPalette(palette);
      rebuildEnvironment();
      applyTextColors();
    } catch (err) {
      warn('套用主題色失敗', err);
    }
  }

  let lyricSig = lyricTextSignature(cfg.lyrics);

  function setConfig(next) {
    if (disposed) return;
    try {
      const prev = cfg;
      cfg = normalizeConfig({ ...cfg, ...(next || {}) });

      // 主題色：只有真的換了 palette 才重烤環境貼圖（烤一次約數十毫秒）
      const nextPalette = PALETTES[cfg.palette] || PALETTES.neon;
      if (nextPalette !== palette) {
        palette = nextPalette;
        applyPalette();
      }

      // 文字：只有字串真的變了才重建（每秒呼叫也不會掉幀）
      let textChanged = false;
      if (cfg.title !== prev.title) { replaceText('title', cfg.title); textChanged = true; }
      if (cfg.tagline !== prev.tagline) { replaceText('tagline', cfg.tagline); textChanged = true; }
      if (cfg.artist !== prev.artist) {
        replaceText('artist', cfg.artist);
        replaceText('artistSmall', cfg.artist);
        textChanged = true;
      }
      if (cfg.cta !== prev.cta) { replaceText('cta', cfg.cta); textChanged = true; }

      const sig = lyricTextSignature(cfg.lyrics);
      if (sig !== lyricSig) {
        lyricSig = sig;
        syncLyrics();
      }
      const colorChanged = cfg.lyricColor !== prev.lyricColor || cfg.titleColor !== prev.titleColor;
      if (textChanged || lyricsRebuilt || colorChanged) {
        applyTextColors();
        lyricsRebuilt = false;
      }

      applyVisibility();
    } catch (err) {
      warn('setConfig 失敗', err);
    }
  }

  // ── resize ──
  function resize(width, height) {
    if (disposed) return;
    try {
      const w = Math.max(2, Math.floor(num(width, 1080)));
      const h = Math.max(2, Math.floor(num(height, 1920)));
      const dpr = typeof window !== 'undefined' ? num(window.devicePixelRatio, 1) : 1;

      // pixelRatio 上限 2；但為了保住錄影輸出尺寸與 iPhone 的幀率，
      // 畫布越大就越趨近 1（這裡用整數倍率，避免錄出奇數長寬讓 H.264 失敗）。
      let pr = clamp(Math.floor(Math.min(dpr, MAX_PIXEL_RATIO)), 1, MAX_PIXEL_RATIO);
      while (pr > 1 && w * h * pr * pr > MAX_DRAWING_PIXELS) pr = Math.floor(pr / 2);

      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false); // 樣式由 main.js 的 CSS 控制，不要覆蓋
      camera.aspect = w / h;
      camera.fov = fovForAspect(camera.aspect);
      camera.updateProjectionMatrix();
      if (post) post.setSize(w, h, pr);

      pointScale = (h * pr) * 0.5;
      for (const key of ['title', 'tagline', 'artist', 'cta', 'artistSmall']) {
        if (texts[key]) texts[key].setPointScale(pointScale);
      }
      for (const obj of texts.lyrics) {
        if (obj) obj.setPointScale(pointScale);
      }
    } catch (err) {
      warn('resize 失敗', err);
    }
  }

  // ── 文字時序（全部由 t 決定）──
  function updateTexts(t, tl, beat) {
    const fovRad = (camera.fov * Math.PI) / 180;
    const worldH = 2 * TEXT_DIST * Math.tan(fovRad * 0.5);
    const worldW = worldH * Math.max(0.1, camera.aspect);

    // 把文字縮到「高度不超過 hFrac、寬度不超過 wFrac」的最小縮放。
    // 直式橫式都用同一套規則，所以長歌詞不會爆框、短標題也不會小到看不見。
    const fitScale = (obj, spec) => {
      if (!obj) return 0.01;
      const sH = worldH * spec.hFrac;
      const sW = (worldW * spec.wFrac) / Math.max(0.2, obj.aspect);
      return Math.max(0.0005, Math.min(sH, sW));
    };

    // 節拍讓文字本體抖一下（因為文字是相機子物件，鏡頭 shake 不會帶動它）
    const jitter = (cfg.shake * 0.07) * (0.3 + beat);
    const jx = Math.sin(t * 73.3) * jitter;
    const jy = Math.cos(t * 61.7) * jitter * 0.8;

    // ① 標題：粒子從散開狀態聚合成字，intro 結尾炸散
    const title = texts.title;
    if (title) {
      const p = t / Math.max(1e-4, tl.introEnd);
      const visible = t < tl.introEnd;
      title.setVisible(visible);
      if (visible) {
        title.setTime(t);
        title.setProgress(smoothstep(0.02, 0.42, p));
        title.setBurst(smoothstep(0.8, 0.99, p));
        title.setOpacity(smoothstep(0.0, 0.15, p) * (1 - smoothstep(0.86, 1.0, p)));
        title.setScale(fitScale(title, TEXT_SPECS.title) * (1 + 0.02 * Math.sin(t * 1.7)));
        title.setPosition(jx, worldH * 0.02 + jy);
      }
    }

    // tagline：標題下方的小字
    const tagline = texts.tagline;
    if (tagline) {
      const p = t / Math.max(1e-4, tl.introEnd);
      const visible = t < tl.introEnd;
      tagline.setVisible(visible);
      if (visible) {
        tagline.setTime(t);
        tagline.setProgress(smoothstep(0.2, 0.55, p));
        tagline.setBurst(smoothstep(0.84, 1.0, p));
        tagline.setOpacity(smoothstep(0.26, 0.46, p) * (1 - smoothstep(0.76, 0.92, p)));
        tagline.setScale(fitScale(tagline, TEXT_SPECS.tagline));
        tagline.setPosition(0, -worldH * 0.115);
      }
    }

    // ② 歌詞：每句各自聚合、句末炸散；同一時間只會有一句是 active
    const lyricY = -worldH * 0.135;
    for (let i = 0; i < texts.lyrics.length; i += 1) {
      const obj = texts.lyrics[i];
      if (!obj) continue;
      const line = cfg.lyrics[i];
      if (!line || cfg.showLyrics === false) {
        obj.setVisible(false);
        continue;
      }
      const st = lyricState(t, line); // 絕對秒數，不乘 k（見 camera.js 說明）
      obj.setVisible(st.active);
      if (!st.active) continue;
      obj.setTime(t);
      obj.setProgress(st.progress);
      obj.setBurst(st.burst);
      obj.setOpacity(st.opacity);
      obj.setScale(fitScale(obj, TEXT_SPECS.lyric));
      obj.setPosition(0, lyricY);
    }

    // ③ 藝名 slam：快速放大 + 震動 + 背景爆光（爆光在 applyFrame 算）
    const artist = texts.artist;
    if (artist) {
      const enter = clamp((t - tl.artistStart) / Math.max(0.05, 0.32 * tl.k), 0, 1);
      const burst = smoothstep(tl.ctaStart - 0.12 * tl.k, tl.ctaStart + 0.28 * tl.k, t);
      const visible = t >= tl.artistStart - 0.01 && t <= tl.ctaStart + 0.32 * tl.k;
      artist.setVisible(visible);
      if (visible) {
        const pop = 0.4 + 0.6 * easeOutBack(enter);
        artist.setTime(t);
        artist.setProgress(clamp(enter * 1.9, 0, 1));
        artist.setBurst(burst);
        artist.setOpacity(smoothstep(0, 0.14, enter) * (1 - burst));
        artist.setScale(fitScale(artist, TEXT_SPECS.artist) * pop * (1 + beat * 0.04));
        artist.setPosition(jx * 1.4, worldH * 0.02 + jy * 1.4);
      }
    }

    // ④ CTA：OUT NOW 上浮，藝名縮成小字留在下方
    const cta = texts.cta;
    const ctaP = clamp((t - tl.ctaStart) / Math.max(1e-4, tl.end - tl.ctaStart), 0, 1);
    if (cta) {
      const visible = t >= tl.ctaStart;
      cta.setVisible(visible);
      if (visible) {
        const appear = smoothstep(0.03, 0.34, ctaP);
        cta.setTime(t);
        cta.setProgress(appear);
        cta.setBurst(0);
        cta.setOpacity(appear * (1 - smoothstep(0.9, 1.0, ctaP)));
        cta.setScale(fitScale(cta, TEXT_SPECS.cta) * (0.84 + 0.16 * easeOutBack(clamp(ctaP / 0.34, 0, 1))));
        cta.setPosition(0, worldH * (0.075 - 0.03 * appear));
      }
    }
    const artistSmall = texts.artistSmall;
    if (artistSmall) {
      const visible = t >= tl.ctaStart;
      artistSmall.setVisible(visible);
      if (visible) {
        const appear = smoothstep(0.12, 0.42, ctaP);
        artistSmall.setTime(t);
        artistSmall.setProgress(appear);
        artistSmall.setBurst(0);
        artistSmall.setOpacity(appear * (1 - smoothstep(0.92, 1.0, ctaP)));
        artistSmall.setScale(fitScale(artistSmall, TEXT_SPECS.artistSmall));
        artistSmall.setPosition(0, -worldH * 0.105);
      }
    }
  }

  // ── 使用者的 3D 動漫角色（VRM / GLB 模型）──
  const AVATAR_POS = { x: 0, y: 0, z: -58 };
  const AVATAR_HEIGHT = 8; // 世界單位；鏡頭飛過時的視覺高度
  let avatar = null;
  let avatarToken = 0;

  async function setAvatar(url) {
    const token = ++avatarToken;
    if (avatar) {
      try { avatar.dispose(); } catch { /* ignore */ }
      avatar = null;
    }
    if (!url) return { ok: false };
    try {
      const created = await createAvatar({ url, height: AVATAR_HEIGHT, tint: palette.key });
      // 載入期間使用者又換了模型 → 丟掉這一個
      if (token !== avatarToken) {
        try { created.dispose(); } catch { /* ignore */ }
        return { ok: false, error: '已被更新的模型取代' };
      }
      avatar = created;
      avatar.object.position.set(AVATAR_POS.x, AVATAR_POS.y, AVATAR_POS.z);
      scene.add(avatar.object);
      applyVisibility();
      return {
        ok: true,
        meshes: avatar.meshCount,
        animations: avatar.animations,
        bones: avatar.bones,
        hasRig: avatar.hasRig,
      };
    } catch (err) {
      warn('3D 角色載入失敗', err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // ── 使用者的 3D 粒子人像（照片取樣，站在城市街道上）──
  // 放在 camera 路徑會經過的位置，鏡頭飛過去才有真實視差。
  const PORTRAIT_POS = { x: 0, y: 13.5, z: -70 };
  const PORTRAIT_HEIGHT = 25;
  let portrait = null;

  function setPortrait(image, enabled = true) {
    try {
      if (portrait) {
        try { portrait.dispose(); } catch { /* ignore */ }
        portrait = null;
      }
      if (!image || enabled === false) return { ok: false };
      portrait = createParticlePortrait({
        image,
        seed: (SEED ^ 0x5e6f7a) >>> 0,
        tint: palette.key, // 深色衣服／暗背景用主題色打亮，否則在夜景裡看不見
      });
      const obj = portrait.object;
      obj.position.set(PORTRAIT_POS.x, PORTRAIT_POS.y, PORTRAIT_POS.z);
      obj.scale.setScalar(PORTRAIT_HEIGHT);
      scene.add(obj);
      applyVisibility();
      return { ok: true, count: portrait.count, aspect: portrait.aspect };
    } catch (err) {
      warn('3D 形象建立失敗', err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // ── 每幀主邏輯 ──
  function applyFrame(t, stats) {
    const D = cfg.duration;
    const tt = clamp(t, 0, D);
    const tl = getTimeline(tt, D);
    const beat = clamp(num(stats.beat, 0), 0, 1);
    const bass = clamp(num(stats.bass, 0), 0, 1);
    const mid = clamp(num(stats.mid, 0), 0, 1);
    const treble = clamp(num(stats.treble, 0), 0, 1);
    const intensity = cfg.intensity;
    const path = cameraPath(tt, D, intensity);

    // ── 鏡頭：分鏡路徑 + 手持微動 + 節拍震動（全部是 t 的函式）──
    camera.fov = fovForAspect(camera.aspect) + path.fovOffset;
    camera.updateProjectionMatrix();

    if (avatar) {
      try { avatar.update(tt, beat); } catch (err) { warn('avatar.update', err); }
    }
    if (portrait) {
      try { portrait.update(tt, beat); } catch (err) { warn('portrait.update', err); }
    }

    const slamAge = tt - tl.artistStart;
    const slamShake = slamAge >= 0 ? Math.exp(-slamAge * 3.2) * 1.5 : 0;
    const shakeAmp =
      cfg.shake * (0.18 + beat * 0.85) * (0.4 + intensity * 0.9) + slamShake * cfg.shake;
    const jx = Math.sin(tt * 61.7) * 0.55 + Math.sin(tt * 37.3 + 1.1) * 0.45;
    const jy = Math.cos(tt * 53.1 + 0.6) * 0.55 + Math.sin(tt * 43.7 + 2.3) * 0.45;
    const jz = Math.sin(tt * 47.9 + 3.1) * 0.5;

    camera.position.set(
      path.pos[0] + jx * shakeAmp,
      path.pos[1] + jy * shakeAmp,
      path.pos[2] + jz * shakeAmp * 0.6,
    );
    camera.lookAt(
      path.look[0] + jx * shakeAmp * 0.35,
      path.look[1] + jy * shakeAmp * 0.35,
      path.look[2],
    );
    camera.rotateZ(path.roll + Math.sin(tt * 0.7) * 0.004 + beat * 0.004 * intensity);

    // 跟著鏡頭跑的兩顆霓虹點光：地面與道具在鏡頭附近才有顏色
    camLightA.position.set(
      camera.position.x + 3.5,
      camera.position.y + 4.5,
      camera.position.z - 7,
    );
    camLightB.position.set(
      camera.position.x - 4.5,
      camera.position.y + 7,
      camera.position.z - 18,
    );
    camLightA.intensity = 55 + beat * 90;
    camLightB.intensity = 35 + beat * 60;

    // ── 子系統動畫 ──
    const frameStats = { beat, bass, mid, treble };
    try { city.update({ time: tt, beat, bass, mid, treble }); } catch (err) { warn('city.update', err); }
    try { props.update(tt, frameStats); } catch (err) { warn('props.update', err); }
    try { atmos.update(tt, camera, frameStats); } catch (err) { warn('atmos.update', err); }
    try { updateTexts(tt, tl, beat); } catch (err) { warn('updateTexts', err); }

    // ── 爆光 / 淡出 / Bloom / 曝光 ──
    let flash = 0;
    if (slamAge >= 0) flash += 0.9 * Math.exp(-slamAge * 5.5);
    for (const line of cfg.lyrics) {
      const dt = tt - num(line.t0, 0); // 歌詞是絕對秒數，不隨 k 縮放
      if (dt >= 0 && dt < 1.5) flash += 0.1 * Math.exp(-dt * 8);
    }
    flash = clamp(flash * (0.45 + intensity * 0.8), 0, 1.3);

    // 結尾 0.6 秒淡出到黑（開場不做淡入：靜止在 t=0 時畫面是滿的，UI 預覽才不會一片黑）
    const fade = smoothstep(tl.end - 0.6 * tl.k, tl.end - 0.02 * tl.k, tt);

    const bloom = cfg.bloom * (0.66 + beat * 0.38 + flash * 0.7);
    renderer.toneMappingExposure = 0.94 + beat * 0.05 + flash * 0.22;
    if (post) {
      post.setParams({ bloom, grain: cfg.grain, fade, flash, time: tt });
    }
  }

  function update(t, stats) {
    if (disposed) return;
    try {
      applyFrame(num(t, 0), stats || {});
    } catch (err) {
      warn('update 失敗', err);
    }
  }

  function render() {
    if (disposed) return;
    try {
      renderer.info.reset();
      if (post) post.render();
      else renderer.render(scene, camera);
    } catch (err) {
      warn('render 失敗', err);
    }
  }

  function info() {
    return {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      pixelRatio: renderer.getPixelRatio(),
      texts: 5 + texts.lyrics.length,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const key of ['title', 'tagline', 'artist', 'cta', 'artistSmall']) {
      if (texts[key]) {
        try { texts[key].dispose(); } catch { /* ignore */ }
      }
    }
    for (const obj of texts.lyrics) {
      if (obj) {
        try { obj.dispose(); } catch { /* ignore */ }
      }
    }
    try { city.dispose(); } catch (err) { warn('city.dispose', err); }
    try { props.dispose(); } catch (err) { warn('props.dispose', err); }
    try { atmos.dispose(); } catch (err) { warn('atmos.dispose', err); }
    if (portrait) { try { portrait.dispose(); } catch { /* ignore */ } portrait = null; }
    if (avatar) { try { avatar.dispose(); } catch { /* ignore */ } avatar = null; }
    try { disposeObject3D(scene); } catch { /* ignore */ }
    try { if (envRT) envRT.dispose(); } catch { /* ignore */ }
    envRT = null;
    try { if (post) post.dispose(); } catch (err) { warn('post.dispose', err); }
    try { renderer.dispose(); } catch { /* ignore */ }
  }

  // ── 初始化 ──
  buildAllTexts();
  applyVisibility();
  resize(canvas.width || 1080, canvas.height || 1920);
  // 先跑一格，讓所有 uniform / 物件狀態就緒（main.js 緊接著會 renderFrame(0)）
  try {
    applyFrame(0, {});
  } catch (err) {
    warn('初始畫面失敗', err);
  }

  return { setConfig, resize, update, render, dispose, info, setPortrait, setAvatar };
}
