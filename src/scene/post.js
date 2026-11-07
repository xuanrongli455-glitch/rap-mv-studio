// rap-mv/src/scene/post.js — 後處理：Bloom + 調色/顆粒/暗角/爆光/淡出。
//
// 順序：RenderPass → UnrealBloomPass → GradePass → OutputPass。
//  • Bloom 解析度刻意只有一半：iPhone 上 UnrealBloomPass 是全片最貴的步驟，
//    半解析度的光暈視覺上幾乎沒差，但 GPU 成本直接砍四倍。
//  • GradePass 在 OutputPass（tone mapping + sRGB 轉換）之前做，
//    所以顆粒、暗角、閃光都還在線性空間，最後才交給 OutputPass 一次轉換。
//  • 淡出到黑也放在這裡：composer 最後一關乘上 (1 - uFade)，
//    比在場景裡放黑色遮罩乾淨（不會被 bloom 暈開）。

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { clamp, num } from './util.js';

const GradeShader = {
  name: 'MVGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uFade: { value: 0 },
    uFlash: { value: 0 },
    uGrain: { value: 0.3 },
    uVignette: { value: 0.9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFade;
    uniform float uFlash;
    uniform float uGrain;
    uniform float uVignette;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // 暗角：把注意力壓在畫面中心，順便讓四角看起來更「鏡頭」
      vec2 d = vUv - 0.5;
      float vig = 1.0 - smoothstep(0.26, 0.94, length(d));
      color.rgb *= mix(1.0 - 0.5 * uVignette, 1.0, vig);

      // 底片顆粒：用時間當種子，錄影逐幀才會跳動
      float n = hash(vUv * 2048.0 + fract(uTime * 9.13) * 317.0) - 0.5;
      color.rgb += n * uGrain * 0.18;

      // 爆光：藝名 slam 瞬間整格泛白（線性空間加超過 1，ACES 之後就是白色）
      color.rgb += vec3(1.9, 1.75, 2.05) * uFlash;

      // 淡入 / 淡出到黑
      color.rgb *= clamp(1.0 - uFade, 0.0, 1.0);

      gl_FragColor = color;
    }
  `,
};

export function createPost({ renderer, scene, camera }) {
  const composer = new EffectComposer(renderer);
  composer.renderToScreen = true;

  const renderPass = new RenderPass(scene, camera);

  // 解析度先用一個保守值，真正的尺寸由 index.js 的 resize() 設定。
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(540, 960),
    0.9,   // strength
    0.62,  // radius
    0.34,  // threshold
  );
  // 覆寫 setSize：composer 傳進來的會再乘上 pixelRatio，這裡一律再砍半。
  const bloomSetSize = bloomPass.setSize.bind(bloomPass);
  bloomPass.setSize = (w, h) => {
    bloomSetSize(Math.max(8, Math.round(w * 0.5)), Math.max(8, Math.round(h * 0.5)));
  };

  const gradePass = new ShaderPass(GradeShader);
  const outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(gradePass);
  composer.addPass(outputPass);

  let disposed = false;

  function setSize(width, height, pixelRatio) {
    const w = Math.max(2, Math.floor(num(width, 1080)));
    const h = Math.max(2, Math.floor(num(height, 1920)));
    const pr = clamp(num(pixelRatio, 1), 0.5, 2);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
  }

  // 由 index.js 每幀把最終數值算好丟進來（index 才是分鏡的擁有者）。
  function setParams({ bloom, grain, fade, flash, time } = {}) {
    bloomPass.strength = clamp(num(bloom, 0.9), 0, 5);
    gradePass.uniforms.uGrain.value = clamp(num(grain, 0.3), 0, 1.5);
    gradePass.uniforms.uFade.value = clamp(num(fade, 0), 0, 1);
    gradePass.uniforms.uFlash.value = clamp(num(flash, 0), 0, 2);
    gradePass.uniforms.uTime.value = num(time, 0);
  }

  function render() {
    if (disposed) return;
    composer.render();
  }

  return {
    composer,
    bloomPass,
    gradePass,
    setSize,
    setParams,
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { bloomPass.dispose(); } catch { /* ignore */ }
      try { gradePass.dispose(); } catch { /* ignore */ }
      try { outputPass.dispose(); } catch { /* ignore */ }
      try { renderPass.dispose(); } catch { /* ignore */ }
      try { composer.dispose(); } catch { /* ignore */ }
    },
  };
}
