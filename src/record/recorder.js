// rap-mv/src/record/recorder.js — 把 canvas 畫面（＋WebAudio 混音）錄成影片
//
// 為什麼這樣設計：
// 1) iOS Safari 的 MediaRecorder 幾乎只支援 video/mp4，桌面 Chrome 則是 webm，
//    所以用 MediaRecorder.isTypeSupported() 挑「這個瀏覽器真的吃得下」的 mimeType，
//    而且建立 MediaRecorder 時還要 try/catch 降級——Safari 有時回報支援，
//    實際 new 的時候又丟錯（尤其是帶 codecs 字串或 bitrate 選項時）。
// 2) canvas.captureStream() 只負責影像；音樂要另外從 audio 模組的
//    MediaStreamAudioDestinationNode 拿 audio track，合成一條 MediaStream 再錄。
//    音訊 track 是 audio 模組的資產，這裡「不能」在停止時把它 stop()，
//    否則錄完一次音樂就斷了。
// 3) stop() 一定要 resolve：Safari 在背景切換/記憶體壓力下偶爾不觸發 onstop，
//    所以加 5 秒保險計時器，至少把已收到的 chunks 包成 Blob。
// 4) 這個模組不 import three。

// 優先序照合約：Safari 的 H.264 mp4 優先，其次 Chrome 的 webm 系。
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

const VIDEO_BITRATE = 8_000_000;
const STOP_FALLBACK_MS = 5000;

function nowMs() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch { /* ignore */ }
  return Date.now();
}

function errText(err) {
  return (err && err.message) || String(err);
}

function stopTracks(tracks) {
  try {
    if (Array.isArray(tracks)) tracks.forEach((t) => { try { t.stop(); } catch { /* 已停止 */ } });
  } catch { /* ignore */ }
}

function readConfig() {
  try {
    if (typeof window !== 'undefined' && window.__MV_CONFIG__) return window.__MV_CONFIG__;
  } catch { /* ignore */ }
  return {};
}

// 檔名不合法字元換成 _，但保留中文（iOS「檔案」App 對中文檔名沒問題）。
function sanitizePart(value, fallback) {
  let s = String(value == null ? '' : value);
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_'); // 各作業系統不合法字元
  s = s.replace(/\s+/g, '_');
  s = s.replace(/_+/g, '_');
  s = s.replace(/^[._]+|[._]+$/g, '');
  s = s.slice(0, 48);
  return s || fallback;
}

function buildFilename(mime, meta) {
  const artist = sanitizePart(meta && meta.artist, 'artist');
  const title = sanitizePart(meta && meta.title, 'mv');
  let ratio = String((meta && meta.ratio) || '9:16').replace(/[:：]/g, 'x');
  ratio = ratio.replace(/[^0-9A-Za-z.x-]/g, '') || '9x16';
  const ext = /mp4/i.test(mime || '') ? 'mp4' : 'webm';
  return `${artist}-${title}-${ratio}.${ext}`;
}

export function createRecorder({ canvas, getAudioStream } = {}) {
  /** @type {null | {rec:MediaRecorder, chunks:Blob[], mime:string, meta:object, startedAt:number, videoTracks:MediaStreamTrack[]}} */
  let session = null;

  function typeSupported(m) {
    try {
      return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
        ? !!MediaRecorder.isTypeSupported(m)
        : false;
    } catch {
      return false;
    }
  }

  function pickMimeType() {
    for (const m of MIME_CANDIDATES) {
      if (typeSupported(m)) return m;
    }
    // 全部回報不支援時回空字串，讓瀏覽器自己決定（有些 Safari 版本會這樣）。
    return '';
  }

  function supportedTypes() {
    return MIME_CANDIDATES.filter((m) => typeSupported(m));
  }

  function isSupported() {
    try {
      return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder === 'function'
        && !!canvas && typeof canvas.captureStream === 'function';
    } catch {
      return false;
    }
  }

  async function start(opts = {}) {
    if (session) throw new Error('已經在錄影中');
    if (!isSupported()) {
      throw new Error('這個瀏覽器不支援錄影（需要 MediaRecorder + canvas.captureStream，iOS 請用 Safari 16.4+）');
    }
    if (!canvas || !canvas.width || !canvas.height) {
      throw new Error('畫布尺寸還是 0，請先讓畫面渲染一帧再錄影');
    }

    const fpsRaw = Number(opts.fps);
    const fps = Number.isFinite(fpsRaw) ? Math.max(1, Math.min(60, Math.round(fpsRaw))) : 30;

    // ── 1) 擷取畫布影像 ──
    let capture = null;
    try {
      capture = canvas.captureStream(fps);
    } catch (err) {
      // 少數實作不吃 fps 參數，退回無參數版本
      try {
        capture = canvas.captureStream();
      } catch (err2) {
        throw new Error('無法擷取畫布串流：' + errText(err2));
      }
    }
    if (!capture) throw new Error('無法擷取畫布串流（captureStream 回傳空值）');

    const videoTracks = capture.getVideoTracks();
    if (!videoTracks.length) {
      stopTracks(videoTracks);
      throw new Error('畫布串流沒有影像軌，請確認 WebGL 有正常渲染');
    }

    // ── 2) 有音檔就混進同一條 MediaStream ──
    const tracks = videoTracks.slice();
    try {
      const audioStream = typeof getAudioStream === 'function' ? getAudioStream() : null;
      if (audioStream && typeof audioStream.getAudioTracks === 'function') {
        for (const t of audioStream.getAudioTracks()) {
          if (t && t.readyState !== 'ended') tracks.push(t);
        }
      }
    } catch (err) {
      // 沒有音訊串流也要能錄無聲影片，不能因此中斷錄影
      console.warn('[recorder] 取得音訊串流失敗，這次會錄成無聲影片', err);
    }

    let stream;
    try {
      stream = new MediaStream(tracks);
    } catch (err) {
      stopTracks(videoTracks);
      throw new Error('無法建立合成串流：' + errText(err));
    }

    // ── 3) 建立 MediaRecorder（多段降級） ──
    const mime = pickMimeType();
    let rec = null;
    let lastErr = null;

    // 多段降級：先試挑到的 mimeType，再依序試其他候選（Safari 有時
    // isTypeSupported 說可以、new 的時候又挑食），最後才不指定。
    const attempts = [];
    const seenMime = new Set();
    const pushAttempt = (options) => {
      const key = options.mimeType || '';
      if (seenMime.has(key)) return;
      seenMime.add(key);
      attempts.push(options);
    };
    if (mime) pushAttempt({ mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE });
    for (const candidate of MIME_CANDIDATES) {
      if (candidate !== mime && typeSupported(candidate)) {
        pushAttempt({ mimeType: candidate, videoBitsPerSecond: VIDEO_BITRATE });
      }
    }
    pushAttempt({ videoBitsPerSecond: VIDEO_BITRATE });
    pushAttempt({}); // 最後手段：什麼都不指定

    for (const options of attempts) {
      try {
        rec = new MediaRecorder(stream, options);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        rec = null;
      }
    }
    if (!rec) {
      stopTracks(videoTracks);
      throw new Error('建立 MediaRecorder 失敗：' + errText(lastErr));
    }

    let actualMime = mime;
    try {
      if (rec.mimeType) actualMime = rec.mimeType; // 以瀏覽器實際採用的為準
    } catch { /* ignore */ }

    const cfg = readConfig();
    const meta = {
      artist: opts.artist || cfg.artist || 'artist',
      title: opts.title || cfg.title || 'mv',
      ratio: opts.ratio || cfg.ratio || '9:16',
    };

    const s = {
      rec,
      chunks: [],
      mime: actualMime,
      meta,
      startedAt: nowMs(),
      videoTracks,
    };
    session = s;

    rec.ondataavailable = (ev) => {
      try {
        if (ev && ev.data && ev.data.size > 0) s.chunks.push(ev.data);
      } catch { /* 忽略單一 chunk 錯誤 */ }
    };
    rec.onerror = (ev) => {
      console.warn('[recorder] MediaRecorder 錯誤', ev && ev.error ? ev.error : ev);
    };

    // 等 MediaRecorder 真的開始錄（onstart）才 resolve：
    // main.js 是「await recorder.start() → 才 audio.play(0)」，太早回傳會讓開頭幾幀
    // 與音樂對不上。加 400ms 計時器當保險（少數實作不發 onstart）。
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(done, 400);

      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { rec.onstart = null; } catch { /* ignore */ }
        resolve();
      }

      try { rec.onstart = done; } catch { /* 沒有 onstart 屬性就算了 */ }

      try {
        rec.start(1000); // 每秒切一段，降低長錄影的記憶體壓力
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    }).catch((err) => {
      session = null;
      stopTracks(videoTracks);
      throw new Error('無法開始錄影：' + errText(err));
    });
  }

  async function stop() {
    const s = session;
    if (!s) return null;
    session = null; // 先歸零：重複呼叫 stop() 不會二次打包

    const rec = s.rec;
    const fallbackMime = s.mime || 'video/webm';
    const duration = Math.max(0, (nowMs() - s.startedAt) / 1000);

    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;

      const finalize = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

        let mime = fallbackMime;
        try { if (rec.mimeType) mime = rec.mimeType; } catch { /* ignore */ }

        let blob = null;
        try {
          blob = new Blob(s.chunks, { type: mime });
        } catch (err) {
          console.warn('[recorder] 打包 Blob 失敗', err);
        }

        // 只停「錄影自己建立的」影像軌；音訊軌屬於 audio 模組，停了音樂就斷了
        stopTracks(s.videoTracks);
        try {
          rec.ondataavailable = null;
          rec.onstop = null;
          rec.onerror = null;
        } catch { /* ignore */ }

        resolve(blob ? { blob, mimeType: mime, filename: buildFilename(mime, s.meta), duration } : null);
      };

      rec.onstop = finalize;
      rec.onerror = (ev) => {
        console.warn('[recorder] 停止時收到 MediaRecorder 錯誤', ev && ev.error ? ev.error : ev);
        finalize();
      };

      // 保險：某些 Safari 在切 App / 記憶體壓力下不會觸發 onstop，
      // 時間到就把已收到的 chunks 包起來，至少不會讓使用者白錄。
      timer = setTimeout(() => {
        try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
        setTimeout(finalize, 400);
      }, STOP_FALLBACK_MS);

      try {
        if (rec.state !== 'inactive') rec.stop();
        else finalize();
      } catch (err) {
        console.warn('[recorder] 呼叫 recorder.stop() 失敗，仍回傳已收到的資料', err);
        finalize();
      }
    });
  }

  function isRecording() {
    return !!session;
  }

  function dispose() {
    const s = session;
    session = null;
    if (!s) return;
    try { if (s.rec.state !== 'inactive') s.rec.stop(); } catch { /* ignore */ }
    try {
      s.rec.ondataavailable = null;
      s.rec.onstop = null;
      s.rec.onerror = null;
    } catch { /* ignore */ }
    stopTracks(s.videoTracks);
  }

  return {
    supportedTypes,
    isSupported,
    start,
    stop,
    isRecording,
    dispose,
  };
}

// 觸發下載。iOS Safari 對 Blob URL + <a download> 的處理是存到「檔案」App
// （或在分享面板讓你選），所以不需要外掛、也不需要 FileSaver。
export function saveBlob(blob, filename) {
  try {
    if (!blob || typeof document === 'undefined') return false;
    const name = String(filename || 'mv.mp4');

    let url = '';
    try {
      url = URL.createObjectURL(blob);
    } catch (err) {
      console.warn('[recorder] 無法建立下載 URL', err);
      return false;
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    // 一定得放進 DOM：iOS Safari 對「不在文件中的 a.click()」支援較差
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.top = '0';
    a.style.width = '1px';
    a.style.height = '1px';
    a.style.opacity = '0';
    a.style.pointerEvents = 'none';
    document.body.appendChild(a);

    try {
      a.click();
    } catch (err) {
      // 少數 WebView 需要手動派發事件
      try {
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (err2) {
        console.warn('[recorder] 無法觸發下載', err2);
      }
    }

    // 600ms 後才 revoke：太早 revoke 會讓 Safari 來不及接手檔案
    setTimeout(() => {
      try { a.remove(); } catch { /* ignore */ }
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 600);

    return true;
  } catch (err) {
    console.warn('[recorder] saveBlob 失敗', err);
    return false;
  }
}
