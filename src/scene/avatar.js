// rap-mv/src/scene/avatar.js — 載入使用者的 3D 角色模型（VRM / GLB），做成動漫風的 3D 角色。
//
// 為什麼不是貼圖：使用者要「真實的動漫 3D 效果」，所以載入真的 3D 模型，
// 站在城市街道上用真的透視/光照渲染（鏡頭飛過會有視差、有影子）。
//
// 動漫感的來源：
//   ① 模型本身（VRoid / Ready Player Me 的貼圖就是動漫風）
//   ② 材質轉成 MeshToonMaterial（階梯式明暗 = 賽璐璐著色）
//   ③ 角色身上加一盞主題色補光（霓虹 rim light）
//   ④ 腳下加一塊柔邊陰影，避免「浮在地上」
//
// 動作：
//   - 模型自帶 animation clip（例如 VRM 的 idle）→ 用 AnimationMixer 播，時間吃場景的 t（維持確定性）
//   - 沒有動畫 → 找骨骼做程序化 idle（呼吸、點頭、手臂微擺、跟著節拍律動）
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 4 階的明暗階梯：讓 MeshToonMaterial 看起來像賽璐璐上色而不是平滑漸層
let gradientMapCache = null;
function gradientMap() {
  if (gradientMapCache) return gradientMapCache;
  const steps = new Uint8Array([100, 160, 210, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientMapCache = tex;
  return tex;
}

function toToon(src) {
  const mat = new THREE.MeshToonMaterial({
    color: src && src.color ? src.color.clone() : new THREE.Color(0xffffff),
    map: src && src.map ? src.map : null,
    gradientMap: gradientMap(),
    transparent: !!(src && src.transparent),
    opacity: src && typeof src.opacity === 'number' ? src.opacity : 1,
    alphaTest: src && typeof src.alphaTest === 'number' ? src.alphaTest : 0,
    side: src && src.side !== undefined ? src.side : THREE.FrontSide,
    emissive: src && src.emissive ? src.emissive.clone() : new THREE.Color(0x000000),
    emissiveIntensity: 0.15,
  });
  if (mat.map) {
    mat.map.colorSpace = THREE.SRGBColorSpace;
    // 頭髮/睫毛常是半透明貼圖，卡通材質不吃 alphaTest 之外的光照透射
    if (mat.transparent && mat.alphaTest === 0) mat.alphaTest = 0.35;
  }
  mat.name = (src && src.name) || 'toon';
  return mat;
}

// 依名稱找骨骼（同時支援 VRM 的 J_Bip_C_Head 與 RPM 的 Head）
function pickBone(bones, ...needles) {
  for (const needle of needles) {
    const key = needle.toLowerCase();
    for (const [name, bone] of Object.entries(bones)) {
      if (name.toLowerCase().includes(key)) return bone;
    }
  }
  return null;
}

/**
 * 載入 3D 角色。
 * @param {{url: string, height?: number, tint?: string}} opts
 */
export async function createAvatar({ url, height = 8, tint = '#00e5ff' } = {}) {
  if (!url) throw new Error('沒有模型檔案');
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);

  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!root) throw new Error('模型裡沒有場景');

  // ── 縮放到指定高度，並把腳底對到 y=0 ──
  const box0 = new THREE.Box3().setFromObject(root);
  const size0 = new THREE.Vector3();
  box0.getSize(size0);
  if (!(size0.y > 1e-4)) throw new Error('模型尺寸異常');
  const scale = height / size0.y;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const box1 = new THREE.Box3().setFromObject(root);
  root.position.y -= box1.min.y; // 腳貼地

  // ── 材質換成卡通著色 ──
  let meshCount = 0;
  root.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    meshCount += 1;
    obj.castShadow = false;
    obj.receiveShadow = false;
    // frustumCulled：蒙皮模型用靜態包圍球會誤判，直接關掉
    obj.frustumCulled = false;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    const toonList = materials.map((m) => toToon(m));
    obj.material = Array.isArray(obj.material) ? toonList : toonList[0];
  });

  const group = new THREE.Group();
  group.add(root);

  // ── 霓虹補光：讓角色在暗色城市裡有輪廓光 ──
  const rim = new THREE.PointLight(new THREE.Color(tint || '#00e5ff'), 2.4, 26, 2);
  rim.position.set(1.6, height * 0.72, 2.2);
  group.add(rim);
  const key = new THREE.PointLight(new THREE.Color('#ffffff'), 1.5, 22, 2);
  key.position.set(-1.8, height * 0.8, 2.6);
  group.add(key);

  // ── 腳下柔邊陰影（避免浮空感）──
  const shadowGeo = new THREE.CircleGeometry(height * 0.42, 32);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  // ── 動畫 ──
  let mixer = null;
  let mixerClip = null;
  if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
    try {
      mixer = new THREE.AnimationMixer(root);
      mixerClip = mixer.clipAction(gltf.animations[0]);
      mixerClip.play();
    } catch {
      mixer = null;
    }
  }

  // ── 程序化 idle（沒有 animation 時）：找骨骼、記住原始姿勢 ──
  const bones = {};
  root.traverse((obj) => {
    if (obj.isBone) bones[obj.name] = obj;
  });
  const rig = {
    hips: pickBone(bones, 'hips', 'j_bip_c_hips'),
    spine: pickBone(bones, 'spine', 'j_bip_c_spine', 'chest'),
    head: pickBone(bones, 'head', 'j_bip_c_head'),
    armL: pickBone(bones, 'leftupperarm', 'leftarm', 'j_bip_l_upperarm', 'l_upperarm'),
    armR: pickBone(bones, 'rightupperarm', 'rightarm', 'j_bip_r_upperarm', 'r_upperarm'),
  };
  const rest = {};
  for (const [k, bone] of Object.entries(rig)) {
    if (bone) rest[k] = { quat: bone.quaternion.clone(), pos: bone.position.clone() };
  }
  const hasRig = !!(rig.hips || rig.spine || rig.head);
  const rootRestY = root.position.y;

  let disposed = false;

  return {
    object: group,
    meshCount,
    animations: Array.isArray(gltf.animations) ? gltf.animations.length : 0,
    hasRig,
    bones: Object.keys(bones).length,
    height,
    setVisible(v) {
      group.visible = v !== false;
    },
    // 純時間函式：t 決定一切（錄影逐幀才會一致）
    update(t, beat = 0) {
      if (disposed) return;
      const tt = Number.isFinite(t) ? t : 0;
      const b = Math.max(0, Math.min(1.5, Number(beat) || 0));

      if (mixer) {
        // 用 setTime 而不是 update(delta)：同樣的 t 一定得到同樣的姿勢
        try { mixer.setTime(tt); } catch { /* ignore */ }
      }

      if (hasRig) {
        const sway = Math.sin(tt * 1.15) * 0.055;
        const breathe = Math.sin(tt * 1.9) * 0.014;
        const nod = Math.sin(tt * 2.3) * 0.05 + b * 0.06;
        const arm = Math.sin(tt * 1.45) * 0.1 + b * 0.05;

        if (rig.hips) {
          rig.hips.position.y = rest.hips.pos.y + breathe + b * 0.012;
          rig.hips.quaternion.copy(rest.hips.quat);
          rig.hips.rotateZ(sway * 0.5);
        }
        if (rig.spine) {
          rig.spine.quaternion.copy(rest.spine.quat);
          rig.spine.rotateZ(-sway * 0.35);
          rig.spine.rotateX(nod * 0.4);
        }
        if (rig.head) {
          rig.head.quaternion.copy(rest.head.quat);
          rig.head.rotateX(nod);
          rig.head.rotateY(sway * 1.6);
        }
        if (rig.armL) {
          rig.armL.quaternion.copy(rest.armL.quat);
          rig.armL.rotateZ(arm);
        }
        if (rig.armR) {
          rig.armR.quaternion.copy(rest.armR.quat);
          rig.armR.rotateZ(-arm);
        }
      } else {
        // 完全沒有骨骼：整隻角色輕輕上下呼吸 + 左右擺
        root.position.y = rootRestY + Math.abs(Math.sin(tt * 1.9)) * 0.05 + b * 0.02;
        root.rotation.z = Math.sin(tt * 1.2) * 0.012;
      }

      // 節拍時霓虹補光變亮
      rim.intensity = 2.0 + b * 1.8;
      shadow.material.opacity = 0.34 + Math.sin(tt * 1.9) * 0.03;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { group.parent && group.parent.remove(group); } catch { /* ignore */ }
      try {
        root.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) if (m) m.dispose();
        });
      } catch { /* ignore */ }
      try { shadowGeo.dispose(); shadowMat.dispose(); } catch { /* ignore */ }
      try { if (mixer) mixer.stopAllAction(); } catch { /* ignore */ }
    },
  };
}
