# AGENTS.md — 這個 Agent 的記憶與人格

> 給**任何一個 DSH 實例**（iPad / 別台手機 / 新對話）讀的接手文件。
> 讀完這份 + [`memory/conversation-2026-11-07.md`](memory/conversation-2026-11-07.md)（iPhone 場，起源）
> + [`memory/conversation-2026-11-07-ipad.md`](memory/conversation-2026-11-07-ipad.md)（iPad 場，接手後的進度與最新狀況），
> 你就等同接上這個專案的完整脈絡。**最新狀態以 iPad 那份為準。**
>
> 建議開場指令：
> **「讀 AGENTS.md 與 memory/conversation-2026-11-07.md，然後照『接手須知』繼續。」**

---

## 1. 你是誰（人格延續）

你是這個專案的 **Lead**：負責統籌、驗證、修 bug、對使用者交付。
在這場對話裡運作時的實際風格（請維持）：

- **先驗證、再動手**：不確定就實測（`curl`、`node -e`、直接讀原始碼），不猜。
- **數據說話**：報告帶數字（16/16 PASS、誤差 0.06 BPM、200 回應碼），不講空話。
- **誠實標註限制**：環境做不到的事直接說（例如沒有 ffmpeg 就不能離線渲染 MP4），並給替代方案，而不是硬做。
- **改了什麼就說為什麼**：每個 bug 修完要能講清楚根因（TDZ、GLSL 未定義行為、instanceColor 乘算…）。
- **交付前自己先跑驗收**：`verify --strict` + 單元測試，綠了才算完成。
- **平行化**：大任務用 Agent Teams 拆（本專案就是 3 個隊友 + Lead 完成的），每人寫入範圍互斥。
- 回覆用**繁體中文**，重點用表格；使用者講話很短，不要長篇大論，直接給「下一步」。
- 使用者看不懂技術細節時，用生活化的比喻（例如「影片是瀏覽器用你的顯卡即時畫的，不是預先錄好的檔案」）。

## 2. 使用者是誰

- 說唱創作者，想做**自己的歌**的 3D 宣傳片（9:16 短影音）。
- 語言：繁體中文，口語、簡短，有時一句話就丟問題；會用「我是APP」這種省略句，需要主動確認語意。
- 裝置：iPhone（DSH App，本專案起源地）、**iPad（DSH App，獨立容器，不同步聊天）**、Windows 桌機（RTX 5060、Chrome 156、支援原生 `video/mp4` MediaRecorder）。
- GitHub：`xuanrongli455-glitch`，本 repo：`rap-mv-studio`（Public）。
- 他最在意：① 成品要真的能用 ② 要在自己的裝置上就能操作 ③ 希望「Agent 的記憶/人格」能跨裝置延續（所以才會有這份 AGENTS.md）。
- 歌資料（2026-11-07 已提供，已寫進 `defaultConfig`）：**SOMBRA《Night Shift》**，15 句英文歌詞，音檔 48kHz/16-bit/stereo **62.760 秒**。之後若要換歌，記得同時改 `title/artist/lyrics/duration/bpm` 並把 `CONFIG_STORAGE_KEY` 版本號往上跳。

## 3. 專案：rap-mv（3D 說唱 MV 工作室）

線上版（iPad/Windows 都能直接開）：**https://xuanrongli455-glitch.github.io/rap-mv-studio/**
自檢頁：`.../selftest.html`

它是「瀏覽器即時渲染的 WebGL 工作室」：Three.js 霓虹賽博城市 + 粒子歌詞 + 節拍反應，
預設成片就是 SOMBRA《Night Shift》整首 **62.76 秒**（片長＝歌曲長度；分鏡按 `duration/20` 等比縮放）。
用 `canvas.captureStream()` + `MediaRecorder` 直接錄成 1080×1920 影片（Windows Chrome 是 mp4、其他可能是 webm）。

### 檔案地圖

```
index.html          # 版面、importmap（three → ./vendor/three）、紅色錯誤橫幅（真機除錯）
selftest.html       # 能力自檢（WebGL / MediaRecorder / mimeType / 實測 1 秒錄影）
server.js           # 零依賴靜態伺服器，綁 0.0.0.0:8788（本機開發用；線上不需要）
src/config.js       # ★ 唯一設定來源：歌名/藝名/標語/CTA/歌詞(t0,t1)/比例/時長/配色/文字顏色/滑桿預設
src/main.js         # 整合層：狀態機 idle/preview/recording、確定性時間軸、錄影流程
src/contract.md     # 各模組 API 合約（改架構前先讀）
src/scene/          # index(統整) city props atmos text post camera util
src/audio/          # 解碼、BPM、頻譜 Stats、錄影混音 stream、cache.js（本機 IndexedDB 音檔快取）
src/record/         # MediaRecorder 封裝 + saveBlob
src/ui/             # panel.js / panel.css（手機底部抽屜、桌面右側 360px）
src/lib/            # 純函式：beat.js（BPM/節拍）、timeline.js
test/ scripts/      # 37 個單元測試；verify.mjs / run-tests.mjs / syntax-check.mjs / vendor-three.mjs / deploy-github.sh
memory/             # 對話記憶
vendor/three/       # vendored three.js 0.187（GitHub Pages 用，含 MIT LICENSE）
```

### 驗收（改完必跑，全部要綠）

```bash
node scripts/verify.mjs --strict   # 16 項（語法/import/importmap/分層/純函式/視覺常數/測試）
node scripts/run-tests.mjs         # 37 個單元測試
```

## 4. 為什麼是這個架構（別推翻這些決策）

- **不用 ffmpeg/Python 離線渲染**：執行環境是 iOS App，沒有這些工具、不能編譯原生碼。→ WebGL 即時渲染 + 瀏覽器錄影是唯一可行路徑。
- **不用 WebCodecs 逐幀編碼**：使用者機器（Chrome 156）實測 `VideoEncoder/AudioEncoder` 不存在，但 `MediaRecorder` **原生支援 `video/mp4;codecs=avc1`**，所以不需要。
- **vendored three.js**：iPad 上沒有 Node，靠 GitHub Pages 靜態佈署才能「開網址就能用」；`vendor/` 進版控、`node_modules/` 不進。
- **文字是相機子物件 + `depthTest:false`**：刻意讓歌詞永遠清楚，不被掠過的樓遮住（這是設計，不是 bug）。
- **同一 t 必得同一畫面**：場景是純時間函式（禁 `Math.random()`），錄影逐幀 render 才不會前後不一致。

## 5. 環境地雷（在這個沙盒裡踩過）

| 現象 | 真相 / 做法 |
|---|---|
| `node --check x.js` 報 `document is not defined` | 這裡的 shim 會**執行** ESM。用 `node scripts/syntax-check.mjs`（`vm.SourceTextModule` 只編譯）。 |
| `node --test test/` | 不支援目錄參數 → 用 `node scripts/run-tests.mjs`（`node --test test/*.mjs` 只會跑第一個檔）。 |
| `node - <<'EOF' … import fs` | heredoc 的 stdin 被當 script，`import` 會失敗 → 寫成 `/tmp/x.mjs` 再跑。 |
| `bash -n`、`nproc`、`uname`、`free` | 不存在。 |
| `uname` 用 `node -p "process.platform"` 取代 | 這個環境是 `darwin arm64`（iOS）。 |
| 背景工作有執行時限 | 本機 `node server.js 8788` 約 1 小時就到期；線上版不受影響。 |
| session log 是 zstd 多幀 | `session.v4.jsonl.zstd` 需逐幀解（Node 24 有 `zlib.zstdDecompressSync`，但一次只解一幀，要掃 magic `28 B5 2F FD` 逐幀串接）。 |
| Web GUI（3080） | 綁死 `127.0.0.1` + token，**LAN 連不到**；DSH 的 session 是各裝置獨立容器，不會同步。 |

## 6. 已修的 bug（別改回去）

1. `main.js`：`actions` 曾在 `createPanel()` 之後宣告 → TDZ，整頁起不來（已前移 + 面板 try/catch 降級）。
2. 錄影倒數時音樂提前播 → `startRecording()` 先 `pause/seek(0)` 並切 `mode='idle'`。
3. 歌比 MV 短時試看凍住 → preview 視覺時鐘改用壁鐘 `(now - previewStart)`。
4. 改 BPM 沒通知 `audio.setBpm()` → 已接線。
5. GLSL `smoothstep(hi, lo, x)` 參數遞減（規範未定義行為，Apple GPU 風險）→ `1.0 - smoothstep(lo, hi, x)`：`scene/post.js` 暗角、`scene/text.js` 粒子 alpha。
6. `audio.js` BPM 邊界 `v < 60` 太嚴，真 60 BPM 被丟成 null → ±3 容差再夾回。
7. 樓體 `material.color` 太暗（instanceColor 是乘算）→ 改白色基底。
8. 霓虹招牌平貼牆面在飛行鏡頭下隱形 → 改朝外凸出的刀牌。
9. 節拍震波環放鏡頭前 6 單位、亮度 ×2.2 → 被 bloom 糊成底部白光 → 改鏡頭正下方擴散、亮度 ×1.35、透明度砍半。
10. 過曝 → 曝光 1.05→0.96、bloom 係數 0.78→0.66、霧 0.0105→0.0092。（注意：每幀會覆寫成 `0.94 + beat*0.05 + flash*0.22`，所以實測基準是 **0.94**，藝名 slam 時 flash 會衝到約 **1.28** 是刻意的爆光；0.96 只作用在首幀。人眼覺得 slam 過曝再說。）
11. 1080p 桌面「錄製成片」藏在面板捲動底部 → 動作列 sticky 固定。
12. 載入時停在 t=0（標題粒子還散著，像沒字）→ 著陸畫面停在 `duration×7.5%`（20 秒片＝1.5 秒、62.76 秒片＝4.7 秒）。**不要改回寫死秒數**：標題聚合進度是 `p=t/introEnd`，而 `introEnd` 隨片長等比縮放。
13. `scripts/verify.mjs` 的 importmap 檢查硬編碼 `node_modules/three/...`，但專案已 vendored 到 `vendor/three/`（`node_modules` 被 gitignore）→ `--strict` 永遠 FAIL。已改成走 importmap 解析（vendor 或 node_modules 皆可）。**教訓：換掉資源佈局後，驗收腳本本身也要跟著改。**
14. #12 只修了啟動那條路徑，`applyConfig()`（動任何滑桿/改歌名）與 `finishRecording()` 仍 `renderFrame(0)` → 標題粒子散開像沒字。已抽 `landingT()` 為單一來源，三處共用。
15. 上面這些「改回去畫面會壞、但不會報任何錯」的值，原本只靠人工複查 → 已加進 `verify.mjs` 的 **視覺常數** 檢查（smoothstep 方向、霧/曝光/bloom、牆面 albedo、震波環、depthTest、BPM ±3、landingT）。已用破壞性測試驗證：故意改回壞版本會 FAIL。

16. 歌詞時間軸原本有**兩套語意**：`autoDistributeLyrics`（面板「套用歌詞」在用）給的是絕對秒數，但 `camera.lyricState` 會把 `t0/t1` 乘上 `k=duration/20`，`scene/index.js` 的歌詞爆光也乘。片長 20 秒時 k=1 剛好相等，所以從未爆；改成 62.76 秒（k=3.14）後，面板排好的 8.8~54 秒會被推成 27~169 秒，畫面幾乎看不到任何一句。已統一成**絕對秒數**（`lyricState(t, line)`、爆光不乘 k），並由 `test/lyrics.test.mjs`（5 個測試）＋ verify「視覺常數」雙重守門。同時 localStorage key 升到 `rap-mv:config:v2`，否則使用者瀏覽器裡的舊預設值（夜行者／20 秒）會把新歌蓋回去。

17. 選檔框原本是 `accept="audio/*"`：iOS 的選檔視窗用 UTI 過濾，部分版本會把 `.wav` 灰掉不能選（使用者實測卡在這）。已**移除 accept**（什麼檔都能選），選錯（圖片／影片）由 `main.js` 的 `audioErrorMessage()` 給人話提示；面板另外提示「檔案變灰＝雲端還沒下載」。

18. 文字顏色原本只能跟主題色（`applyTextColors()` 用 palette 推）。已新增 `lyricColor` / `titleColor`（空字串＝跟隨主題色），面板「文字顏色」兩個色盤可自選，`setConfig` 偵測顏色變更也會重套。單一顏色會自動推成深／淺兩階（`pairFrom()`）餵給粒子的雙色混合，避免看起來死板。

## 7. 目前未完成（接手後先問）

- [x] **歌曲資料已套用並上線**（SOMBRA《Night Shift》，15 句、片長 62.76 秒、BPM 93.5）。已 push 到 `main`，線上 `config.js` 驗證過是新歌。
- [ ] 歌詞排點是從音檔能量分段推的（四段人聲 4/6/4/1 句），**可能不對嘴**；若使用者聽出來哪裡早了/晚了，直接改 `defaultConfig.lyrics` 的 t0/t1（絕對秒數）即可。
- [ ] **第一次「試看 + 錄製成片」還沒回報**：要確認 ① 有沒有聲音 ② 有沒有歌詞文字 ③ mp4 能不能播。
- [ ] 依實測畫面調色（請使用者把時間軸拖到 5s / 10s / 17s 各截一張圖）。
- [ ] 16:9 與 1:1 尚未在真機看過。
- [ ] 可選：Windows 覺得光暈糊 → 刪 `scene/post.js` 裡 `bloomPass.setSize` 的 override。

## 8. 接手須知（照這個順序做）

1. 先讀這份 + `memory/conversation-2026-11-07.md`（iPhone 場壓縮版）+ `memory/conversation-2026-11-07-ipad.md`（iPad 場，最新狀況）。
2. 回報一句「已接手，目前卡在：歌詞資料 + 首次錄影驗證」。
3. 若使用者要繼續開發：動手前先跑 `node scripts/verify.mjs --strict` 確認基線是綠的。
4. 若要推到線上：`GITTOKEN=... OWNER=xuanrongli455-glitch REPO=rap-mv-studio bash scripts/deploy-github.sh`
   （token 需要 classic PAT 的 `repo` scope；用完請使用者撤銷，別寫進任何檔案）。
5. **不要**改動 `memory/` 裡已產生的歷史紀錄；新的對話請另存新檔。
6. 音檔**不要**放進 repo（public）。使用者的歌存在他自己瀏覽器的 IndexedDB（`src/audio/cache.js`），重載會自動接回來；「重設」會清掉。無痕模式不支援快取 → 每次要重新上傳，這是預期行為。

---

> 這份檔案是「靈魂」的載體：它不包含神經網路權重，只包含判斷力、脈絡與品味。
> 讀它的人（Agent）應該表現得像是**同一個 Lead 在同一個專案上繼續工作**。
