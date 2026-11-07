#!/usr/bin/env node
// rap-mv/scripts/syntax-check.mjs — 純語法檢查（只解析，不執行）
//
// 為什麼不用 `node --check`？
//   在 iPhone 的 DSH 沙盒裡，`node` 是 worker 模擬出來的（見 DSH
//   runtime/node-worker.mjs）：它把 argv 中第一個「非旗標」參數當成要執行的
//   腳本，`--check` 被當成一般旗標忽略 → 變成「真的去執行該檔案」。
//   對含 document / WebGL 的瀏覽器模組來說，這會丟 ReferenceError 而被誤判成
//   語法錯誤；對缺 import 的檔案則會丟 ERR_MODULE_NOT_FOUND。兩者都不是語法問題。
//
// 這裡改用 node 內建的 V8 模組解析器 `vm.SourceTextModule`：
//   new vm.SourceTextModule(code) 只「編譯」不「連結 / 執行」，
//   所以能抓到真正的語法錯誤，又不會碰到 DOM。
//   注意：需要 `--experimental-vm-modules`。在 DSH 沙盒裡以命令列旗標傳不進去，
//   要改用環境變數 NODE_OPTIONS（由 verify.mjs 負責），見下方說明。
//
// 用法：NODE_OPTIONS=--experimental-vm-modules node scripts/syntax-check.mjs <file...>
// 輸出：每個失敗的檔案一行 `SYNTAX\t<path>\t<message>`；全部通過則無輸出。
// 結束碼：0 = 全部通過；1 = 有語法錯誤；3 = 這個環境沒有 vm.SourceTextModule。
import fs from 'node:fs';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  // verify.mjs 會看這個標記，改走 --check / 執行期錯誤分類的 fallback
  console.log('VM_UNAVAILABLE');
  process.exit(3);
}

const files = process.argv.slice(2);
let bad = 0;
for (const file of files) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    // 只建立模組（編譯 + 語法檢查），不呼叫 link()/evaluate()，所以零副作用
    new vm.SourceTextModule(src, { identifier: file });
  } catch (err) {
    bad += 1;
    const message = String((err && err.message) || err).split('\n')[0];
    console.log(`SYNTAX\t${file}\t${message}`);
  }
}
process.exit(bad ? 1 : 0);
