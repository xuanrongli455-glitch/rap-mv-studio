#!/usr/bin/env node
// rap-mv/scripts/run-tests.mjs — 在 iOS DSH 沙盒裡執行全部單元測試的等價入口
//
// 為什麼需要這支？
//   1. 正常 Node（桌機 / CI）：`node --test test/` 就會跑 test/*.test.mjs。
//   2. 本專案也會在 iPhone App 的 DSH 沙盒裡被自檢，而沙盒的 `node` 是 worker
//      模擬出來的（見 DSH 的 runtime/node-worker.mjs）：它把 argv 中第一個
//      「非旗標」參數當成要執行的腳本路徑，所以 `node --test test/` 的 `test/`
//      會被當成腳本 → ERR_UNSUPPORTED_DIR_IMPORT（目錄不能 import）。
//   這支腳本改成「逐檔 import」，node:test 會自動執行所有註冊的測試，
//   行為與 `node --test` 相同、失敗時同樣以 exit code 1 結束。
//
// 用法：node scripts/run-tests.mjs
// 結束碼：0 = 全綠；1 = 有測試失敗 / 找不到測試檔。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

const files = fs.existsSync(TEST_DIR)
  ? fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).sort()
  : [];

if (files.length === 0) {
  console.error('[run-tests] test/ 底下找不到 *.test.mjs，沒有東西可跑');
  process.exit(1);
}

console.log(`[run-tests] 以 node:test 執行 ${files.length} 個測試檔：${files.join('、')}`);
for (const file of files) {
  // 逐檔載入；node:test 會自動跑完並在結束時設定正確的 exit code
  await import(pathToFileURL(path.join(TEST_DIR, file)).href);
}
