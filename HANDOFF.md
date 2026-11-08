# HANDOFF — 3D 說唱 MV 工作室（跨裝置交接用）

> 給「另一個裝置 / 另一個對話裡的 DSH」看的接手文件。把這份檔案貼給任何新對話，
> 就能無縫接上進度，不需要同步聊天記錄（DSH 的 session 是本機檔案，不跨裝置）。

最後更新：2026-11-07

## 0. 一句話現況

專案在 iPhone 的這個 App 容器裡，**已完成並全綠**（`verify --strict` 17/17、單元測試 26/26）。
使用者已在 Windows Chrome（RTX 5060、Chrome 156）成功看到 3D 畫面，且該瀏覽器**原生支援 `video/mp4` 錄影**。
還缺：① 使用者的歌名/藝名/歌詞 ② 首次成功錄出成片 ③ 依實測畫面調色。

## 1. 這是什麼

因為執行環境是 iOS App（沒有 ffmpeg / Python / 原生編譯），不可能離線渲染 MP4。
所以做成**瀏覽器即時渲染的 WebGL 工作室**：Three.js 3D 霓虹城市 + 粒子歌詞 + 節拍反應，
用 `canvas.captureStream()` + `MediaRecorder` 直接錄成 1080×1920 的影片。

```
rap-mv/
├── index.html          # 版面、importmap（three → /vendor/three）、紅色錯誤橫幅（真機除錯用）
├── selftest.html       # 能力自檢頁（WebGL / MediaRecorder / mimeType / 實測 1 秒錄影）
├── server.js           # 零依賴靜態伺服器，綁 0.0.0.0:8788，LAN 可存取
├── src/
│   ├── config.js       # ★ 歌名、藝名、標語、CTA、歌詞與 t0/t1、比例、時長、配色、滑桿預設
│   ├── main.js         # 整合層：狀態機（idle/preview/recording）、確定性時間軸、錄影流程
│   ├── contract.md     # 各模組 API 合約
│   ├── scene/          # 3D：index(統整) city props atmos text(post) camera util
│   ├── audio/          # WebAudio：解碼、BPM、頻譜 Stats、錄影混音 stream
│   ├── record/         # MediaRecorder 封裝 + saveBlob
│   ├── ui/             # 控制面板 panel.js / panel.css
│   └── lib/            # 純邏輯（可 node 測）：beat.js（BPM/節拍）、timeline.js
├── test/               # 31 個 node:test 單元測試
└── scripts/            # verify.mjs（17 項自檢）、run-tests.mjs、syntax-check.mjs
```

## 2. 怎麼啟動 / 驗收

```bash
cd /home/dsh/Documents/deepseek-harness/default-workspace/rap-mv
node server.js 8788              # 背景跑；會印出 127.0.0.1 與 LAN 網址
node scripts/verify.mjs --strict # 17 項自檢（交付模式）
node scripts/run-tests.mjs       # 31 個單元測試
```

- 同機：`http://127.0.0.1:8788/`
- 同 Wi-Fi（Windows / iPad）：`http://<手機 Wi-Fi IP>:8788/`（本次是 `192.168.0.134`）
- 自檢頁：`/selftest.html`

> **伺服器是背景工作**，App 被系統回收或重啟就沒了 → 叫 DSH「開工作室」重啟，IP 可能變。

## 3. 環境地雷（踩過，別再踩）

| 現象 | 真相 |
|---|---|
| `node --check xxx.js` 報 `document is not defined` | 這個 shim 的 `--check` **會執行** ESM。改用 `scripts/syntax-check.mjs`（`vm.SourceTextModule` 只編譯）。 |
| `node --test test/` 報 `ERR_UNSUPPORTED_DIR_IMPORT` | 不支援目錄參數。用 `node scripts/run-tests.mjs`。 |
| `node --test test/*.test.mjs` 只跑第一個檔 | shim 把第二個檔當 argv 丟掉。同上。 |
| `node - <<EOF ... import fs from 'node:fs'` | heredoc 的 stdin 腳本會被當成 script，`import` 失敗。寫成 `/tmp/x.mjs` 再 `node /tmp/x.mjs`。 |
| Web GUI（3080）從 LAN 連不到 | `boot.mjs` 寫死 `--host 127.0.0.1`，且需要 token。iPad 無法用它看同一個對話。 |

## 4. 已修過的真 bug（別改回去）

1. `main.js`：`actions` 曾在 `createPanel()` 之後才宣告 → TDZ，整頁起不來。已移到前面 + 面板 try/catch 降級。
2. 錄影倒數期間音樂提前播 → `startRecording()` 先 `pause/seek(0)` 並把 mode 切 idle。
3. 歌比 MV 短時試看凍住 → preview 視覺時間軸改用壁鐘 `(now - previewStart)`，音樂只負責節拍。
4. 改 BPM 沒通知 `audio.setBpm()` → 已接線。
5. GLSL 兩處 `smoothstep(hi, lo, x)` 參數遞減（規範未定義行為，Apple GPU 風險）→ 改成 `1.0 - smoothstep(lo, hi, x)`：
   - `scene/post.js` 暗角
   - `scene/text.js` 粒子 alpha
6. `audio.js` BPM 邊界 `v < 60` 太嚴，真 60 BPM 被丟成 null → 改 ±3 容差再夾回。
7. 樓體 `material.color` 太暗 → instanceColor 乘上去整城發黑；已改白色基底。
8. 霓虹招牌平貼牆面在飛行鏡頭下等於隱形 → 改成朝外凸出的刀牌。
9. 節拍地面震波環放在鏡頭前 6 單位、亮度 ×2.2 → 被 bloom 糊成畫面底部一道白光；已改成鏡頭正下方往外擴散、亮度 ×1.35、透明度砍半。
10. 過曝 → 曝光 1.05→0.96、bloom 係數 0.78→0.66、霧 0.0105→0.0092（`scene/index.js`）。
11. 1080p 桌面上「錄製成片」藏在面板捲動區底部 → 動作列 sticky 固定（`ui/panel.css` 末尾）。
12. 載入時停在 t=0（標題粒子還散著，像沒字）→ 著陸畫面停在 `duration×7.5%`（**不寫死秒數**，`main.js` 的 `landingT()`）。

## 5. 待辦 / 下一步

- [ ] **等使用者給歌名、藝名、歌詞（2–6 句）** → 寫進 `src/config.js` 的 `defaultConfig`（含歌詞 t0/t1）
- [ ] 使用者首次「錄製成片」驗證：有無聲音、mp4 能否播放、有無歌詞文字
- [ ] 依實測畫面（拖時間軸到 5s / 10s / 17s 截圖）調亮度、構圖、歌詞位置
- [ ] 若 Windows 覺得光暈偏糊：刪 `scene/post.js` 裡 `bloomPass.setSize` 的 override（回到全解析度）
- [ ] 若要超取樣：`scene/index.js` 的 `MAX_DRAWING_PIXELS`（現在 3e6，故意讓 1080×1920 用 pixelRatio=1）
- [ ] 16:9 / 1:1 尚未真機看過（分鏡與 fov 會自動適配，但沒人看過）

## 6. 已知限制

- 錄影是**即時**捕捉（MediaRecorder），不是逐幀離線編碼 → 電腦不夠力時可能掉幀；`preserveDrawingBuffer: true` 是為了「存海報」，若掉幀可改 `false`。
- iPad/iPhone 的 Safari 也可能支援 mp4 錄影，但**未實測**；先開 `/selftest.html` 確認。
- 中文字形靠系統字型（PingFang TC / 微軟正黑體）；缺 CJK 字型的裝置會變方塊。
