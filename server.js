// rap-mv/server.js — 零依賴靜態伺服器。
// 用途：ES module + WebGL 不能用 file:// 開，必須走 http://127.0.0.1。
// 啟動：node server.js [port]      預設 8788
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.argv[2] || process.env.PORT || 8788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ico': 'image/x-icon',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const joined = path.normalize(path.join(root, decoded));
  if (!joined.startsWith(root)) return null; // 阻擋 path traversal
  return joined;
}

// /vendor/three/... → node_modules/three/...
function resolveFile(urlPath) {
  // vendor/three 已複製進專案（GitHub Pages 也用同一份），優先服務本地檔案；
  // 只有本地還沒 vendored 時才退回 node_modules。
  if (urlPath.startsWith('/vendor/three/')) {
    const local = safeJoin(ROOT, urlPath);
    if (local && fs.existsSync(local)) return local;
    return safeJoin(path.join(ROOT, 'node_modules', 'three'), urlPath.slice('/vendor/three'.length));
  }
  const direct = safeJoin(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  return direct;
}

const server = http.createServer(async (req, res) => {
  try {
    let file = resolveFile(req.url || '/');

    // 沒副檔名 → 當 SPA 路由，回 index.html
    if (file && !path.extname(file)) file = path.join(ROOT, 'index.html');
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('forbidden');
    }

    let stat;
    try {
      stat = await fsp.stat(file);
      if (stat.isDirectory()) {
        file = path.join(file, 'index.html');
        stat = await fsp.stat(file);
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found: ' + req.url);
    }

    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      // 讓 WebGL/recorder 相關 API 在同源下可用
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Access-Control-Allow-Origin': '*',
    };
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + (err && err.message));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lines = [
    '',
    '  🎤 3D 說唱 MV 工作室已啟動',
    '',
    `  本機（iPhone 的 Safari 直接開）：http://127.0.0.1:${PORT}/`,
  ];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) lines.push(`  同網段裝置：http://${a.address}:${PORT}/`);
    }
  }
  lines.push('', '  按 Ctrl+C 或關掉這個指令即停止', '');
  console.log(lines.join('\n'));
});
