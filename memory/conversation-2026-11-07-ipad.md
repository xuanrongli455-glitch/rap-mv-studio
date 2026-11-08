# 對話記憶：iPad 場接手（2026-11-07 ~ 11-08）

這是「iPad 上的 DSH」接手 2026-11-07 iPhone 那場對話後的工作紀錄。
iPhone 那場的完整記憶在 [`conversation-2026-11-07.md`](conversation-2026-11-07.md)，人格與判斷力在 [`../AGENTS.md`](../AGENTS.md)。

## 開場狀況

- 裝置：**iPad 的 DSH 容器**，workspace 是空的 → 先 `git clone` 公開 repo 才接得下去。
- 使用者開場：讀 AGENTS.md + memory，然後照「接手須知」繼續。
- **基線是紅的**：`verify --strict` 只有 14/15（不是文件寫的全綠）。

## 接手後修掉 / 發現的東西

| # | 問題 | 根因 | 處置 |
|---|---|---|---|
| 1 | `verify --strict` 永遠 FAIL 1 項 | `verify.mjs` 硬編碼檢查 `node_modules/three`，但專案已 vendored 到 `vendor/three`（`node_modules` 被 gitignore） | 改走 importmap 解析（AGENTS #13） |
| 2 | 動任何滑桿／錄完，標題粒子散開像沒字 | #12 只修了啟動路徑，`applyConfig()` 與 `finishRecording()` 仍 `renderFrame(0)` | 抽 `landingT()` 單一來源（AGENTS #14） |
| 3 | 12 個已修 bug 是否回歸？ | — | 派唯讀稽核員逐項查：**12/12 + 4 個架構不變量全部仍在** |
| 4 | 文件說曝光 0.96，實際是 0.94 | 每幀覆寫成 `0.94 + beat*0.05 + flash*0.22`；slam 峰值 ~1.28 是**刻意爆光** | 只改文件說明，沒動畫面（AGENTS #10 補註） |
| 5 | 「改回去畫面會壞但不會報錯」的值只靠人眼 | — | verify 新增第 16 項「視覺常數」，並用**破壞性測試**證明：注入 4 個回歸 → 全部被抓到（AGENTS #15） |
| 6 | **片長一旦不是 20 秒，歌詞就會爛** | `autoDistributeLyrics`（面板）給絕對秒數，`camera.lyricState` 卻再 ×k=duration/20 | 統一成絕對秒數（AGENTS #16），雙重守門 |

| 7 | 使用者在 iPad 選不到 `.wav`（檔案灰色） | 選檔框 `accept="audio/*"` 被 iOS 的 UTI 過濾 + 檔案其實還在雲端沒下載 | 移除 `accept`（什麼都能選）＋ `audioErrorMessage()` 給人話提示＋面板說明「變灰＝雲端未下載」 |
## 使用者給的資料（重要）

- 歌：**SOMBRA《Night Shift》**，15 句英文歌詞。
- 音檔：`Night Shift.wav.WAV`，PCM 16-bit / 48kHz / stereo / **62.760 秒**（11.5 MB）。
  - **不要放進 repo**（public）。現在靠 `src/audio/cache.js`（IndexedDB）存在使用者自己瀏覽器。
- BPM：`beat.js` 偵測 **93.53**，confidence **0.124**（低）。低頻 kick 自相關交叉驗證仍多候選分數接近 → **這首歌的 tempo 從混音判不出來**。面板可手改，上傳時也會自動再偵測套用。
- 能量分段（實測）：0.20–1.63、2.18–6.27、**7.06–23.31**、**24.18–36.90**、37.88–39.37、**41.31–55.01**、**56.71–61.88**。
  四段人聲 = 16.25/12.72/13.70/5.17 秒，對上歌詞結構 **4 副歌 / 6 主歌 / 4 副歌重複 / 1 收尾 = 15 句** → 歌詞照這個排（不是平均分）。
- 節拍格線（93.53 BPM）：beat 0.642s、bar 2.566s、全長約 24.5 小節、首拍 0.269s。

## 這次的交付（已 push 到 main）

- 成片片長 = `duration: 62.76`（＝歌曲長度），分鏡按 `duration/20`（k=3.138）等比縮放：
  intro 0–8.16s｜歌詞段 8.16–50.84s｜藝名 slam 50.84–56.48s｜CTA 56.48–62.76s。
- 15 句歌詞以**絕對秒數**寫在 `src/config.js`。
- `landingT()` 改成 `duration×7.5%`（→ 4.71 秒；標題聚合進度 p≈0.58）。
- `CONFIG_STORAGE_KEY` 升 `rap-mv:config:v2`（否則使用者瀏覽器舊設定會把新歌蓋回去）。
- 音檔本機快取：`src/audio/cache.js` + `main.js` 啟動還原（沒有手勢就等第一次觸碰再試），「重設」會清。
- 測試 26 → **37 個**（新增 `test/lyrics.test.mjs` 5 個、`test/audio-cache.test.mjs` 6 個）。
- 驗收：`verify --strict` **16/16**、`run-tests` **37/37**。
- 上線驗證：線上模組圖 **31 個檔案全 200 / 2363 KB / 0 個解析失敗**；線上 `config.js` 已確認是新歌。

## 目前狀態 / 下一步

- [ ] **第一次實測還沒回報**：① 有沒有聲音 ② 歌詞對不對嘴 ③ mp4 能不能播。
- [ ] 歌詞排點是能量推測，**可能不對嘴**；使用者聽出來就改 `defaultConfig.lyrics` 的 t0/t1（絕對秒數）。
- [ ] 藝名 slam（50.84–56.48s）會和第 13、14 句同框，覺得擠就調 `camera.js` 的 `STORY.lyricsEnd`。
- [ ] 截圖調色（時間軸拖到幾個點截圖）。
- [ ] 16:9 / 1:1 仍未在真機看過。
- [ ] iPad Safari 的 IndexedDB 行為未實測（無痕模式一定不支援，屬預期）。63 秒錄影的效能也未實測。

## 環境地雷（這場新增）

| 現象 | 真相 |
|---|---|
| `git fetch` 卡住超過 60 秒 | 連 GitHub 有時很慢 → 直接 `git push https://x-access-token:$TOKEN@...` 反而會成功 |
| GitHub API `/pages/builds/latest` 回 401 | 沒帶 token 就會 401；用「直接抓線上檔案比對內容」驗證部署更可靠 |
| 瀏覽器端的 IndexedDB / MediaRecorder | Node 端只能用替身（fake）測邏輯，真機行為要使用者實測 |
