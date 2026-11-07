// rap-mv/scripts/vendor-three.mjs — 把 three.js 需要的檔案複製進專案。
//
// 為什麼要這樣做：
//   原本 index.html 的 importmap 指到 /vendor/three/*，由 server.js 轉到 node_modules/three。
//   但使用者要在 iPad 上「直接開網址」使用（GitHub Pages / 任何靜態空間），那裡沒有 Node，
//   也沒有 node_modules。所以把 three 的 build 與實際用到的 addons（含它們互相 import 的
//   shader/Pass）全部複製到 vendor/three/，並改成相對路徑 → 整個專案就是純靜態網站。
//
// 用法：node scripts/vendor-three.mjs   （在 rap-mv/ 目錄下執行）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'node_modules', 'three');
const DEST = path.join(ROOT, 'vendor', 'three');

// 我們的程式碼實際 import 的 addon 進入點
const ENTRIES = [
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/OutputPass.js',
  'postprocessing/ShaderPass.js',
];

function readImports(code) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  // 動態 import('...')
  const re2 = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(code))) out.push(m[1]);
  return out;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function run() {
  if (!fs.existsSync(SRC)) {
    console.error('找不到 node_modules/three，請先 `pnpm add three`');
    process.exit(1);
  }
  fs.rmSync(DEST, { recursive: true, force: true });

  // 1) build：three.module.js 會 import './three.core.js'，整個 build 目錄一起帶走最保險
  const buildDir = path.join(SRC, 'build');
  let buildCount = 0;
  for (const name of fs.readdirSync(buildDir)) {
    if (!name.endsWith('.js')) continue;
    // webgpu/tsl 這些我們沒用到，跳過以縮小體積
    if (/webgpu|tsl/.test(name)) continue;
    copyFile(path.join(buildDir, name), path.join(DEST, 'build', name));
    buildCount++;
  }

  // 2) addons：從進入點 BFS 追相對 import
  const jsmRoot = path.join(SRC, 'examples', 'jsm');
  const queue = [...ENTRIES];
  const done = new Set();
  let addonCount = 0;
  while (queue.length) {
    const rel = queue.shift();
    if (done.has(rel)) continue;
    done.add(rel);
    const from = path.join(jsmRoot, rel);
    if (!fs.existsSync(from)) {
      console.warn('⚠ 缺少 addon：', rel);
      continue;
    }
    copyFile(from, path.join(DEST, 'examples', 'jsm', rel));
    addonCount++;
    const code = fs.readFileSync(from, 'utf8');
    for (const spec of readImports(code)) {
      if (!spec.startsWith('.')) continue; // 'three' 由 importmap 處理
      const target = path.normalize(path.join(path.dirname(rel), spec));
      if (target.startsWith('..')) {
        // 指到 examples/jsm 之外（例如 ../../build/three.module.js）→ 已經在 build 裡
        console.warn('  (跨目錄 import，略過):', rel, '→', spec);
        continue;
      }
      queue.push(target);
    }
  }

  // 3) 授權（three.js 是 MIT，重新散布必須附上）
  for (const name of ['LICENSE', 'package.json']) {
    const p = path.join(SRC, name);
    if (fs.existsSync(p)) copyFile(p, path.join(DEST, name));
  }

  const size = (dir) => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? size(p) : fs.statSync(p).size;
    }
    return n;
  };
  const kb = (size(DEST) / 1024).toFixed(0);
  console.log(`✅ vendor/three 完成：build ${buildCount} 檔、addons ${addonCount} 檔、共 ${kb} KB`);
  console.log('   版本：', JSON.parse(fs.readFileSync(path.join(DEST, 'package.json'), 'utf8')).version);
}

run();
