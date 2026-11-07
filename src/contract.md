# 模組合約（唯一真相：src/main.js 怎麼呼叫，你就怎麼實作）

`src/main.js` 是整合層，已寫好。**不要修改 main.js / index.html / config.js / server.js**（Lead 擁有）。
你只寫自己被分配的檔案，並且必須完全符合下面的 API——main.js 會照這樣呼叫。

## 共用型別

```js
// Config：見 src/config.js 的 defaultConfig
// { title, artist, tagline, cta, lyrics:[{text,t0,t1}], duration, fps, ratio,
//   bpm, palette, intensity, shake, bloom, grain, showCity, showVinyl, showMic,
//   showParticles, showLyrics, showRain }

// Palette：PALETTES[cfg.palette] → { bg, fog, key, accent, special, text, ground }（皆為 CSS hex 字串）

// Stats（每一幀傳給場景；無音檔時由 main.js 用 lib/beat.js 的 syntheticStats 產生）
// { t, rms, bass, mid, treble, beat,          // 全部 0..1，beat 是每次重拍後衰減的包絡
//   beatIndex, bpm, playing, hasAudio }
```

## A. 3D 場景 — `src/scene/index.js`

```js
export function createScene({ canvas, config }) {
  // canvas: HTMLCanvasElement（已存在於 DOM，尺寸由 main.js 用 resize 指定）
  return {
    setConfig(nextConfig),        // 主題色/文字/開關改了要即時生效，不需要重建 scene
    resize(width, height),        // 設定 renderer 尺寸與 camera aspect（pixelRatio 由你決定，上限 2）
    update(t, stats),             // t = 影片已播放秒數（0..duration）；更新動畫、鏡頭、歌詞、粒子
    render(),                     // 真正畫一幀
    dispose(),                    // 釋放幾何/材質
    info(),                       // optional: { drawCalls, triangles }
  };
}
```

要點：
- 內建 postprocessing（UnrealBloomPass）可直接用 `three/addons/...`（index.html 已設 importmap）。
- 直式 9:16 構圖為主，16:9 要能看（camera fov／主體高度依 aspect 自動調整）。
- 不要在模組頂層就建立 WebGL 資源，全部放在 createScene 內。
- `update` 必須是純時間函式（同一個 t 得到同樣畫面），因為錄影是逐幀按時間 render。

## B. 音訊 — `src/audio/audio.js`

```js
export async function createAudio() {
  return {
    loadFile(file),                    // File → Promise<{name, duration, bpm}>；分析 BPM
    async ensureContext(),             // 使用者手勢後 resume AudioContext
    play(fromTime = 0),                // 從指定秒數播放（要能邊播邊錄）
    pause(),
    stop(),
    seek(t),
    setBpm(bpm),                       // 手動指定／覆寫 BPM
    getBpm(),
    isLoaded(),                        // bool
    getTime(),                         // 目前播放秒數（沒有音檔回傳 0）
    getStats(tFallback),               // 回傳 Stats；沒音檔時走合成節拍
    getStream(),                       // MediaStream（給錄影混音）或 null
    dispose(),
  };
}
```

## C. 錄影 — `src/record/recorder.js`

```js
export function createRecorder({ canvas, getAudioStream }) {
  return {
    supportedTypes(),       // string[]，例如 ['video/mp4;codecs=h264','video/webm;codecs=vp9']
    isSupported(),          // bool
    async start({ fps }),   // 開始錄 canvas.captureStream；若有音訊 stream 要混進去
    async stop(),           // 停止 → 回傳 { blob, mimeType, filename, duration }
    isRecording(),
    dispose(),
  };
}
export function saveBlob(blob, filename); // 觸發下載（iOS Safari 用 <a download>）
```

要點：iOS Safari 只有 `video/mp4` 可用，Chrome/Safari 桌面可能 `video/webm`。用 `MediaRecorder.isTypeSupported` 挑。
`start()` 必須在 `canvas.captureStream()` 之前確保 canvas 已 render 過至少一幀。

## D. UI — `src/ui/panel.js`

```js
export function createPanel({ config, onChange, audio, recorder, actions }) {
  // actions = { play(), pause(), record(), stopRecord(), reset(), applyConfig(cfg) }
  return {
    refresh(config),            // 外部改了 config（例如按 reset）要同步 UI
    setStatus(text, kind),      // kind: 'info'|'warn'|'error'|'ok'
    setRecording(bool),
    setProgress(ratio, seconds),// 0..1 錄影/播放進度
    dispose(),
  };
}
```
UI 掛載點：`#panel`（右側 / 手機下方抽屜）。CSS 你自己寫在 `src/ui/panel.css`（index.html 已 link）。

## E. 純邏輯 — `src/lib/`（可在 node 裡測，不要碰 DOM）

- `src/lib/beat.js`：
  ```js
  export function analyzeBpm(channelData, sampleRate, opts?)  // → { bpm, confidence, beats: number[] }
  export function createTracker(sampleRate, bpm)              // → { push({rms,bass,mid,treble,now}): {rms,bass,mid,treble,beat,beatIndex} , reset() }
  export function syntheticStats(t, bpm, duration)            // → Stats（無音檔時的假節拍）
  export function cacheBypassNorm(...)                        // 自由實作
  ```
- `src/lib/timeline.js`：
  ```js
  export function buildTimeline(config)      // → { sections:[{kind,t0,t1}], lyricAt(t) → {index,line,progress}|null }
  export function autoDistributeLyrics(lines, duration, lead = 0.14, tail = 0.86) // → [{text,t0,t1}]
  export function formatTime(sec)            // → '0:04.2'
  export function clamp(v, a, b)
  ```
