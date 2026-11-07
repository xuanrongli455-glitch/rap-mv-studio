import { execFileSync } from 'node:child_process';
try {
  const out = execFileSync('node', ['scripts/_syn.mjs', 'src/lib/beat.js'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules' },
  });
  console.log('spawn-with-env OK:', out.trim());
} catch (e) { console.log('spawn-with-env FAILED:', String(e.stderr || e.message).slice(0, 200)); }
