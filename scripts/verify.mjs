#!/usr/bin/env node
// rap-mv/scripts/verify.mjs — 專案自檢腳本（給 Lead 一鍵確認整包專案狀態）
//
// 用法：
//   node scripts/verify.mjs            開發模式：隊友模組還沒寫出來 → WARN，不算 FAIL
//   node scripts/verify.mjs --strict   交付模式：main.js 直接 import 的模組缺一個就 FAIL
//
// 為什麼語法檢查不用 `node --check`？
//   在 iPhone 的 DSH 沙盒裡，`node` 是 worker 模擬的（runtime/node-worker.mjs）：
//   `--check` 會被當成一般旗標忽略、下一個參數被當成「要執行的腳本」，
//   於是 `node --check src/main.js` 其實是「執行 main.js」→ 撞到 document 就丟
//   ReferenceError、缺 import 就丟 ERR_MODULE_NOT_FOUND，兩者都被誤當成語法錯誤。
//   所以這裡優先改用 scripts/syntax-check.mjs（vm.SourceTextModule 只編譯不執行，
//   需要 NODE_OPTIONS=--experimental-vm-modules），拿不到這個能力時才 fallback：
//     - 先探測 --check 是否真的只解析（用一個 throw 的探針檔）
//     - 若 --check 會執行檔案 → 只有 SyntaxError 才算語法錯誤，其餘視為
//       「語法通過、只是需要瀏覽器環境」。
//
// 檢查項目：
//   1. 必要核心檔案存在（main.js / config.js / src/lib/beat.js / src/lib/timeline.js）
//   2. src/**/*.js 語法檢查（只解析不執行，見上）
//   3. src 每個檔案的「相對 import」目標是否存在（含 main.js 的 import；
//      缺 src/lib 或 config.js → 一定 FAIL；隊友目錄缺檔 → 開發模式 WARN、--strict FAIL）
//   4. index.html 的 importmap："three" 與 "three/addons/" 要對應到實體檔案
//      （vendored → vendor/three/...，否則退回 node_modules/three/...；兩者皆可）
//   5. src 掃描（先去掉整行註解，降低誤報）：
//      - ui / audio / record 不該 import 'three'
//      - 不該出現 file:// 資源載入、require(
//      - 不該依賴 python / ffmpeg 這類環境裡不存在的東西（WARN，軟性）
//      - src/lib 不得使用 DOM / window / AudioContext（純函式庫）
//      - src/scene 內的 Math.random()（WARN，update 應為純時間函式）
//      - 視覺常數：AGENTS.md 第 6 節那些「改回去畫面就會壞、但不會報錯」的值
//        （smoothstep 方向、霧/曝光/bloom、牆面 albedo、震波環、depthTest、
//         BPM ±3 容差、landingT）；破壞性測試驗證過會 FAIL
//   6. 單元測試：src/lib 兩支都在就實際跑 test/*.test.mjs
//      - 正常 Node 用 `node --test test/`
//      - iOS DSH 沙盒不支援目錄參數時，自動改用 scripts/run-tests.mjs（等價）
//
// 結束碼：有任何 FAIL → 1，否則 0。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.slice(2).includes('--strict');

const results = [];
const record = (level, name, detail = '') => results.push({ level, name, detail });
const pass = (name, detail) => record('PASS', name, detail);
const warn = (name, detail) => record('WARN', name, detail);
const fail = (name, detail) => record('FAIL', name, detail);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const firstLine = (s) =>
  String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';

// 遞迴列出檔案（跳過 node_modules 與隱藏目錄）
function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// 用目前這支 node 執行子程序（'node' 字串在 DSH 沙盒與正常環境都可用）
function runNode(args, timeout = 180000, env = undefined) {
  return execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: env || process.env,
  });
}

// 把 --experimental-vm-modules 併進 NODE_OPTIONS（沙盒裡命令列旗標傳不進 worker）
function withVmFlag() {
  const current = String(process.env.NODE_OPTIONS || '').trim();
  if (current.includes('--experimental-vm-modules')) return current;
  return `${current} --experimental-vm-modules`.trim();
}

// 去掉「整行註解」後再掃描，避免文件說明被誤判（例如註解提到 file://）
function codeOnly(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

// 把 importmap 的 URL 對到真實檔案：
//   /vendor/three/... → node_modules/three/...（server.js 的 vendor 對應規則）
//   /node_modules/... → 專案根目錄下的 node_modules/...
function resolveImportTarget(target) {
  let t = String(target || '');
  if (/^https?:\/\//i.test(t) || /^data:/i.test(t)) return null; // 遠端資源不是本地檔案
  t = t.replace(/^\/+/, '').replace(/^\.\//, '');
  if (t.startsWith('vendor/three/')) {
    // 已 vendored（GitHub Pages 佈署用）就指回本地，否則才退回 node_modules
    const local = path.join(ROOT, t);
    if (fs.existsSync(local)) return local;
    return path.join(ROOT, 'node_modules', 'three', t.slice('vendor/three/'.length));
  }
  return path.join(ROOT, t);
}

// 從測試輸出抓「pass / fail」統計（node --test 用 "# pass N"，直接跑檔用 "ℹ pass N"）
function testSummary(output) {
  const text = String(output || '');
  const grab = (key) => {
    const m = text.match(new RegExp(`(?:^|\\n)(?:#|ℹ)\\s*${key}\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const p = grab('pass');
  const f = grab('fail');
  if (p == null && f == null) return '';
  return `pass ${p ?? '?'} / fail ${f ?? '?'}`;
}

// ── 語法檢查：只解析、不執行 ──────────────────────────────────
// 解析 syntax-check.mjs 的輸出（每個錯誤一行 SYNTAX\t<path>\t<message>）
function parseVmErrors(output) {
  const errors = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.startsWith('SYNTAX\t')) continue;
    const parts = line.split('\t');
    errors.push({ file: rel(parts[1] || ''), message: parts[2] || '語法錯誤' });
  }
  return errors;
}

// 探測 `node --check` 在這個環境是「只解析」還是「其實會執行」（DSH 沙盒是後者）
function probeCheckMode() {
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-verify-'));
    const probe = path.join(dir, 'probe.mjs');
    fs.writeFileSync(probe, "throw new Error('__MV_PROBE_EXECUTED__');\n", 'utf8');
    try {
      runNode(['--check', probe], 15000);
      return 'parse'; // 沒有執行 → 真正的 parse-only --check
    } catch (err) {
      const stderr = String(err?.stderr || '');
      if (stderr.includes('__MV_PROBE_EXECUTED__')) return 'execute'; // 被執行 → 用錯誤類型分類
      return 'unknown';
    }
  } catch {
    return 'unknown';
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清不掉就算了 */
      }
    }
  }
}

// 回傳 { mode, errors }；mode: 'vm' | 'check' | 'execute' | 'unknown'
function syntaxCheckAll(files) {
  const helper = path.join(ROOT, 'scripts', 'syntax-check.mjs');

  // 1) 首選：vm.SourceTextModule（只編譯、不 link / 不 evaluate）
  if (isFile(helper)) {
    try {
      const out = runNode([helper, ...files], 120000, {
        ...process.env,
        NODE_OPTIONS: withVmFlag(),
      });
      return { mode: 'vm', errors: parseVmErrors(out) };
    } catch (err) {
      const stdout = String(err?.stdout || '');
      if (stdout.includes('VM_UNAVAILABLE')) {
        // 這個 node 沒有 vm.SourceTextModule → 走 fallback
      } else if (err?.status === 1 && /(?:^|\n)SYNTAX\t/.test(stdout)) {
        return { mode: 'vm', errors: parseVmErrors(stdout) };
      }
      // helper 本身跑不起來（例如環境拒絕 NODE_OPTIONS）→ 走 fallback
    }
  }

  // 2) Fallback：--check；若這個 shim 的 --check 其實會執行檔案，
  //    只有 SyntaxError 才算語法錯誤（ReferenceError/TypeError 是缺少瀏覽器環境）
  const probe = probeCheckMode();
  const errors = [];
  for (const file of files) {
    try {
      runNode(['--check', file], 20000);
    } catch (err) {
      const stderr = String(err?.stderr || '');
      if (stderr.includes('SyntaxError')) {
        errors.push({ file: rel(file), message: firstLine(stderr) });
      } else if (probe !== 'execute') {
        errors.push({ file: rel(file), message: firstLine(stderr) });
      }
      // probe === 'execute' 且非 SyntaxError → 檔案語法 OK，只是不能在 node 裡執行
    }
  }
  return { mode: probe, errors };
}

function check() {
  // ── 1. 必要檔案 ────────────────────────────────────────────────
  const required = [
    'src/main.js',
    'src/config.js',
    'src/lib/beat.js',
    'src/lib/timeline.js',
    'index.html',
    'package.json',
  ];
  const missingRequired = required.filter((f) => !isFile(path.join(ROOT, f)));
  if (missingRequired.length) {
    fail('必要檔案', `缺少：${missingRequired.join('、')}`);
  } else {
    pass('必要檔案', `${required.length} 個核心檔案都存在`);
  }
  const pkgType = /"type"\s*:\s*"module"/.test(read(path.join(ROOT, 'package.json')));
  if (pkgType) pass('ESM', 'package.json type = module（純 ESM）');
  else fail('ESM', 'package.json 沒有 "type": "module"');

  // ── 2. src/**/*.js 語法檢查（只解析、不執行）──────────────────
  const srcDir = path.join(ROOT, 'src');
  const jsFiles = walk(srcDir).filter((f) => f.endsWith('.js'));
  const syntax = syntaxCheckAll(jsFiles);
  for (const e of syntax.errors) {
    fail(`語法 ${e.file}`, e.message);
  }
  if (syntax.errors.length === 0) {
    const modeText = {
      vm: 'vm.SourceTextModule 只解析不執行',
      check: 'node --check（parse-only）',
      execute: 'node 載入解析（此環境 --check 會執行，已排除執行期錯誤）',
      unknown: 'node --check（fallback，未驗證模式）',
    }[syntax.mode] || syntax.mode;
    pass('語法檢查', `${jsFiles.length} 個 .js 全部通過（${modeText}）`);
  }

  // ── 3. import 目標是否存在（每個 src 檔案的相對 import 都檢查）──
  const importProblems = []; // { from, spec, target }
  const bareProblems = [];
  const KNOWN_BARE = /^three(?:\/addons\/[^'"]*)?$/;
  for (const file of jsFiles) {
    const code = codeOnly(read(file));
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!isFile(target)) {
          importProblems.push({ from: rel(file), spec, target: rel(target) });
        }
      } else if (!KNOWN_BARE.test(spec) && !spec.startsWith('node:')) {
        bareProblems.push(`${rel(file)} → ${spec}`);
      }
    }
  }
  if (bareProblems.length) {
    warn('import 來源', `出現不明的 bare specifier（不得新增 npm 依賴，也不該有錯字）：${bareProblems.join('、')}`);
  } else {
    pass('import 來源', 'bare specifier 只有 three / three/addons（沒有新增 npm 依賴）');
  }

  // main.js 直接 import 的檔案（題目明確要求：6 個模組缺一 → 交付前 FAIL）
  const mainPath = path.join(ROOT, 'src', 'main.js');
  const mainSrc = codeOnly(read(mainPath));
  const mainSpecs = new Set();
  for (const m of mainSrc.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('.')) mainSpecs.add(m[1]);
  }
  const mainMissing = [];
  for (const spec of mainSpecs) {
    const target = path.resolve(path.dirname(mainPath), spec);
    if (!isFile(target)) mainMissing.push({ spec, target: rel(target) });
  }
  if (mainSpecs.size === 0) {
    warn('main.js import', '解析不到任何相對 import（main.js 格式可能變了？）');
  } else if (mainMissing.length === 0) {
    pass('main.js import', `${mainSpecs.size} 個相對 import 全部存在`);
  } else {
    for (const item of mainMissing) {
      const teammateOwned = /^\.\/(scene|audio|record|ui)\//.test(item.spec);
      if (teammateOwned && !STRICT) {
        warn(`main.js import ${item.spec}`, `缺少 ${item.target}（隊友模組還沒寫完；--strict 時會視為 FAIL）`);
      } else {
        fail(`main.js import ${item.spec}`, `缺少 ${item.target}`);
      }
    }
  }

  // 其他檔案（例如 scene/index.js import ./city.js）的缺失：
  // 隊友之間互相引用還沒寫完 → 開發模式 WARN；--strict（交付前）→ FAIL。
  // 缺的是 src/lib 或 config.js → 一律 FAIL（核心相依）。
  const hardMissing = importProblems.filter(
    (p) => /^src\/lib\//.test(p.from) || /^src\/lib\//.test(p.target) || p.from === 'src/config.js',
  );
  const softMissing = importProblems.filter((p) => !hardMissing.includes(p));
  for (const p of hardMissing) fail(`import 檔案 ${p.from} → ${p.spec}`, `缺少 ${p.target}`);
  if (softMissing.length === 0) {
    pass('import 檔案', 'src 內所有相對 import 的目標都存在');
  } else {
    for (const p of softMissing) {
      if (STRICT) fail(`import 檔案 ${p.from} → ${p.spec}`, `缺少 ${p.target}`);
      else warn(`import 檔案 ${p.from} → ${p.spec}`, `缺少 ${p.target}（隊友檔案未完成）`);
    }
  }

  // ── 4. index.html importmap 與 three 實體檔案 ─────────────────
  const htmlPath = path.join(ROOT, 'index.html');
  const html = read(htmlPath);
  if (!isFile(htmlPath)) {
    fail('index.html', 'index.html 不存在');
  } else {
    const mapMatch = html.match(/<script[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!mapMatch) {
      fail('importmap', 'index.html 找不到 <script type="importmap">');
    } else {
      let map = null;
      try {
        map = JSON.parse(mapMatch[1]);
      } catch (err) {
        fail('importmap', `JSON 解析失敗：${err?.message || err}`);
      }
      if (map) {
        const imports = map.imports || {};
        const problems = [];
        const notes = [];
        for (const key of ['three', 'three/addons/']) {
          const target = imports[key];
          if (typeof target !== 'string' || !target) {
            problems.push(`${key} 沒有對應路徑`);
            continue;
          }
          const resolved = resolveImportTarget(target);
          if (!resolved) {
            problems.push(`${key} 指向遠端 URL（${target}），不是本地 three 套件`);
            continue;
          }
          const ok = key.endsWith('/') ? isDir(resolved) : isFile(resolved);
          if (!ok) problems.push(`${key} → ${target}（解析成 ${rel(resolved)}，不存在）`);
          else notes.push(`${key} → ${rel(resolved)}`);
        }
        // 兩個實體路徑也直接驗一次，但走 importmap 解析：
        // 已 vendored（GitHub Pages 佈署）就檢查 vendor/three 內的實體檔，
        // 尚未 vendored 才退回 node_modules — 不再硬編碼單一路徑。
        const threeBuild = resolveImportTarget(imports['three']);
        const threeAddons = resolveImportTarget(imports['three/addons/']);
        if (!threeBuild || !isFile(threeBuild)) {
          problems.push(`three 實體檔不存在（${threeBuild ? rel(threeBuild) : '未解析'}）`);
        }
        if (!threeAddons || !isDir(threeAddons)) {
          problems.push(`three/addons 目錄不存在（${threeAddons ? rel(threeAddons) : '未解析'}）`);
        }
        if (problems.length) fail('importmap', problems.join('；'));
        else pass('importmap', notes.join('；'));
      }
    }

    // index.html 指到的專案內靜態檔案
    const localRefs = new Set();
    for (const m of html.matchAll(/(?:src|href)=["'](\.{1,2}\/[^"']+)["']/g)) {
      localRefs.add(m[1]);
    }
    const missingRefs = [...localRefs].filter((ref) => {
      const p = path.resolve(ROOT, ref.replace(/^\.\//, ''));
      return !isFile(p);
    });
    if (missingRefs.length === 0) {
      if (localRefs.size) pass('index.html 資源', `${localRefs.size} 個本地 src/href 都存在`);
    } else {
      for (const ref of missingRefs) {
        const p = ref.replace(/^\.\//, '');
        if (/^src\/(ui|scene|audio|record)\//.test(p)) {
          warn(`index.html 資源 ${ref}`, '尚未建立（隊友檔案未完成）');
        } else {
          fail(`index.html 資源 ${ref}`, '檔案不存在');
        }
      }
    }
  }

  // ── 5. src 內容掃描 ───────────────────────────────────────────
  const scannedCode = new Map(); // rel → codeOnly()
  for (const f of jsFiles) scannedCode.set(rel(f), codeOnly(read(f)));

  // 5a. ui / audio / record 不該 import three
  const nonThreeDirs = [];
  for (const [name, code] of scannedCode) {
    if (!/^src\/(ui|audio|record)\//.test(name)) continue;
    if (/(?:\bfrom\s*|\bimport\s*\()\s*['"]three(?:\/[^'"]*)?['"]/.test(code)) nonThreeDirs.push(name);
  }
  if (nonThreeDirs.length) {
    fail('分層規則', `ui/audio/record 不該 import three：${nonThreeDirs.join('、')}`);
  } else {
    pass('分層規則', 'ui/audio/record 沒有 three 依賴（純 DOM / WebAudio / MediaRecorder）');
  }

  // 5b. file:// 與 require(
  const fileUrlHits = [];
  const requireHits = [];
  for (const [name, code] of scannedCode) {
    if (/(?:import|from|fetch|load|src|href)\s*\(?\s*["'`]file:\/\//.test(code)) fileUrlHits.push(name);
    if (/\brequire\s*\(/.test(code)) requireHits.push(name);
  }
  if (fileUrlHits.length) fail('file:// 載入', fileUrlHits.join('、'));
  else pass('file:// 載入', 'src 沒有任何 file:// 資源載入');
  if (requireHits.length) fail('require()', `${requireHits.join('、')} 使用了 require(（必須純 ESM）`);
  else pass('require()', 'src 沒有 require(（純 ESM）');

  // 5c. python / ffmpeg 依賴（軟性）
  const externalDeps = [];
  for (const [name, code] of scannedCode) {
    if (/\b(ffmpeg|ffprobe|python3?|node-gyp)\b/.test(code)) externalDeps.push(name);
  }
  if (externalDeps.length) {
    warn('外部依賴', `提到 python/ffmpeg 之類環境外工具（請確認只是註解）：${externalDeps.join('、')}`);
  } else {
    pass('外部依賴', 'src 沒有依賴 python / ffmpeg');
  }

  // 5d. src/lib 必須是純函式庫（不能碰 DOM / window / AudioContext）
  const libFiles = jsFiles.filter((f) => /^src\/lib\//.test(rel(f)));
  const forbiddenLib = /\b(window|document|localStorage|sessionStorage|navigator|AudioContext|OfflineAudioContext|HTMLCanvasElement|requestAnimationFrame)\b/;
  const libProblems = [];
  for (const f of libFiles) {
    const code = scannedCode.get(rel(f));
    if (forbiddenLib.test(code)) libProblems.push(`${rel(f)} 用到 DOM / window / AudioContext`);
    if (/(?:\bfrom\s*|\bimport\s*\()\s*['"]three/.test(code)) libProblems.push(`${rel(f)} import 了 three`);
  }
  if (libProblems.length) fail('src/lib 純函式', libProblems.join('；'));
  else if (libFiles.length === 0) warn('src/lib 純函式', 'src/lib 下沒有檔案');
  else pass('src/lib 純函式', `${libFiles.length} 個檔案沒有 DOM / window / three 依賴`);

  // 5e. scene 內的 Math.random（軟性 WARN：update 應為純時間函式）
  const sceneRandom = [];
  for (const [name, code] of scannedCode) {
    if (/^src\/scene\//.test(name) && /\bMath\.random\s*\(/.test(code)) sceneRandom.push(name);
  }
  if (sceneRandom.length) {
    warn('scene 確定性', `出現 Math.random()：${sceneRandom.join('、')}（update 應為純時間函式，否則錄影每幀會抖）`);
  } else {
    pass('scene 確定性', 'scene 沒有 Math.random()');
  }

  // 5f. 視覺常數與已修 bug 的硬檢查（這些值被改回去，畫面就會壞，但不會有任何錯誤訊息）
  //     每一條都對應 AGENTS.md 第 6 節的一個 bug，靠人工複查會漏 → 交給機器守。
  {
    const problems = [];
    const okNotes = [];
    const srcPath = (relPath) => path.join(ROOT, relPath);
    const body = (relPath) => {
      try {
        return fs.readFileSync(srcPath(relPath), 'utf8');
      } catch {
        problems.push(`${relPath} 不存在`);
        return '';
      }
    };
    const must = (relPath, re, label, code) => {
      if (!code) return;
      if (re.test(code)) okNotes.push(label);
      else problems.push(`${relPath} 找不到 ${label}`);
    };

    // (1) GLSL smoothstep 參數遞減 = 規範未定義行為（Apple GPU 風險）
    const sceneJs = jsFiles.map((f) => ({ name: rel(f), code: read(f) })).filter((f) => /^src\/scene\//.test(f.name));
    let smoothCount = 0;
    for (const f of sceneJs) {
      for (const m of f.code.matchAll(/smoothstep\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g)) {
        smoothCount += 1;
        if (parseFloat(m[1]) >= parseFloat(m[2])) {
          problems.push(`${f.name}：smoothstep(${m[1]}, ${m[2]}, …) 參數遞減（GLSL 未定義行為）`);
        }
      }
    }
    if (smoothCount) okNotes.push(`${smoothCount} 處 smoothstep 皆遞增`);

    const idx = body('src/scene/index.js');
    must('src/scene/index.js', /const FOG_DENSITY = 0\.0092;/, '霧濃度 0.0092', idx);   // bug #10
    must('src/scene/index.js', /toneMappingExposure = 0\.96;/, '首幀曝光 0.96', idx);      // bug #10
    must('src/scene/index.js', /toneMappingExposure = 0\.94 \+ beat \* 0\.05/, '每幀曝光基準 0.94', idx); // bug #10
    must('src/scene/index.js', /0\.66 \+ beat \* 0\.38/, 'bloom 基準係數 0.66', idx);      // bug #10

    const city = body('src/scene/city.js');
    must('src/scene/city.js', /color:\s*new THREE\.Color\(0xffffff\)/, '牆面白色基底', city); // bug #7
    must('src/scene/city.js', /WALL_ALBEDO = 7\.5/, 'WALL_ALBEDO 7.5', city);                // bug #7
    must('src/scene/city.js', /const faceX =/, '招牌朝外凸出（faceX）', city);                // bug #8

    const atmos = body('src/scene/atmos.js');
    must('src/scene/atmos.js', /multiplyScalar\(1\.35\)/, '震波環亮度 1.35', atmos);          // bug #9
    must('src/scene/atmos.js', /beat \* beat \* 0\.3/, '震波環透明度 0.3', atmos);            // bug #9

    const text = body('src/scene/text.js');
    must('src/scene/text.js', /depthTest:\s*false/, '文字 depthTest:false', text);           // 架構決策

    const audio = body('src/audio/audio.js');
    must('src/audio/audio.js', /MIN_BPM - 3/, 'BPM 邊界 ±3 容差', audio);                     // bug #6

    const main = body('src/main.js');
    must('src/main.js', /function landingT\(\)/, '著陸畫面 landingT()', main);               // bug #12/#14
    if (main) {
      const landingUses = (main.match(/landingT\(\)/g) || []).length;
      if (landingUses >= 3) okNotes.push(`landingT 用於 ${landingUses} 處`);
      else problems.push(`src/main.js：landingT() 只用於 ${landingUses} 處（啟動/改設定/錄完應共用）`);
      // bug #14：idle 改設定時不能寫死 renderFrame(0)
      const fn = main.match(/function applyConfig\([\s\S]*?\n\}/);
      if (fn && /renderFrame\(\s*0\s*\)/.test(fn[0])) {
        problems.push('src/main.js：applyConfig() 仍寫死 renderFrame(0)（idle 改設定會讓標題粒子散開）');
      }
    }

    if (problems.length) fail('視覺常數', problems.join('；'));
    else pass('視覺常數', okNotes.join('；'));
  }

  // ── 6. 單元測試 ───────────────────────────────────────────────
  const beatFile = path.join(ROOT, 'src', 'lib', 'beat.js');
  const timelineFile = path.join(ROOT, 'src', 'lib', 'timeline.js');
  const testDir = path.join(ROOT, 'test');
  const testFiles = isDir(testDir)
    ? fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs'))
    : [];
  if (!isFile(beatFile) || !isFile(timelineFile)) {
    fail('單元測試', 'src/lib/beat.js 或 src/lib/timeline.js 不存在，無法跑測試');
  } else if (testFiles.length === 0) {
    warn('單元測試', 'test/ 下沒有 *.test.mjs');
  } else {
    try {
      // 正常 Node：`node --test test/` 會跑目錄下所有測試
      const out = runNode(['--test', 'test/']);
      pass('單元測試', `node --test test/ 全綠（${testSummary(out) || `${testFiles.length} 個測試檔`}）`);
    } catch (err) {
      const stderr = String(err?.stderr || '');
      const stdout = String(err?.stdout || '');
      const runner = path.join(ROOT, 'scripts', 'run-tests.mjs');
      if (stderr.includes('ERR_UNSUPPORTED_DIR_IMPORT') && isFile(runner)) {
        // iOS DSH 沙盒的 node 不支援目錄參數 → 改成逐檔 import（等價執行）
        try {
          const out2 = runNode(['scripts/run-tests.mjs']);
          pass(
            '單元測試',
            `全綠（${testSummary(out2) || `${testFiles.length} 個測試檔`}；iOS 沙盒不支援 node --test 目錄參數，已改用 scripts/run-tests.mjs 等價執行）`,
          );
        } catch (err2) {
          fail('單元測試', `scripts/run-tests.mjs 失敗：${firstLine(err2?.stderr) || testSummary(err2?.stdout)}`);
        }
      } else {
        fail('單元測試', `node --test test/ 失敗：${firstLine(stderr) || firstLine(stdout) || '未知錯誤'}`);
      }
    }
  }
}

// ── 主流程 ─────────────────────────────────────────────────────
try {
  check();
} catch (err) {
  fail('自檢腳本', `執行時發生未預期錯誤：${err?.message || err}`);
}

const counts = { PASS: 0, WARN: 0, FAIL: 0 };
for (const r of results) counts[r.level] += 1;

const mode = STRICT ? '交付模式 --strict' : '開發模式';
console.log('');
console.log(`=== rap-mv 專案自檢（${mode}）===`);
for (const r of results) {
  const detail = r.detail ? ` — ${r.detail}` : '';
  console.log(`${r.level.padEnd(5)} ${r.name}${detail}`);
}
console.log('─'.repeat(64));
console.log(`共檢查 ${results.length} 項：PASS ${counts.PASS} / WARN ${counts.WARN} / FAIL ${counts.FAIL}`);
if (counts.FAIL > 0) {
  console.log('結果：FAIL ❌（請修正上面的 FAIL 項目）');
  process.exit(1);
}
if (counts.WARN > 0) {
  console.log('結果：PASS ✅（有 WARN：隊友模組若尚未完成屬正常，交付前請再跑一次 --strict）');
} else {
  console.log('結果：全部 PASS ✅');
}
