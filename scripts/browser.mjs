// Headless Chromium with a real GPU where possible, plus a Vite dev server for the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** FAL_KEY from the environment, else from .env / .env.local in the repo (the dev server reads the same files). */
export async function falKey() {
  if (!process.env.FAL_KEY) {
    const { loadEnv } = await import('vite');
    const key = loadEnv('development', ROOT, 'FAL_').FAL_KEY;
    if (key) process.env.FAL_KEY = key;
  }
  return process.env.FAL_KEY;
}

export async function launchBrowser() {
  const env = { ...process.env };
  const args = ['--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
  const extraLibs = `${process.env.HOME}/chrome-deps/root/usr/lib/x86_64-linux-gnu`; // user-space NSS/ALSA (no sudo here)
  const libs = [];
  if (fs.existsSync(extraLibs)) libs.push(extraLibs);
  // Windows: ANGLE's D3D11 backend runs on the real GPU in headless Chromium (TROMPE_ANGLE to pick another).
  if (process.platform === 'win32') args.push(`--use-angle=${process.env.TROMPE_ANGLE ?? 'd3d11'}`);
  if (fs.existsSync('/usr/lib/wsl/lib/libd3d12.so')) {
    // WSL2: Mesa's D3D12 driver gives ANGLE the real GPU instead of SwiftShader.
    libs.push('/usr/lib/wsl/lib');
    env.GALLIUM_DRIVER = 'd3d12';
    env.MESA_D3D12_DEFAULT_ADAPTER_NAME ??= 'NVIDIA';
    args.push('--use-angle=gl-egl');
  }
  if (libs.length) env.LD_LIBRARY_PATH = [...libs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  // TROMPE_CHROME: use this browser instead of Playwright's own
  return chromium.launch({ headless: true, args, env, ...(process.env.TROMPE_CHROME ? { executablePath: process.env.TROMPE_CHROME } : {}) });
}

export async function startServer() {
  const { createServer } = await import('vite');
  // No HMR or file watching: edits made while a long run is going must not reload the page under it.
  const server = await createServer({ root: ROOT, logLevel: 'warn', server: { port: 5179, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  return { server, url: server.resolvedUrls.local[0] };
}

/** Open the app headless and wait for window.trompe. Console lines starting with TROMPE are passed to onEvent. */
export async function openApp(browser, url, { width = 1280, height = 720, onEvent, onLog } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('TROMPE ')) onEvent?.(JSON.parse(t.slice(7)));
    else if (msg.type() === 'error' || msg.type() === 'warning') onLog?.(`[${msg.type()}] ${t}`);
  });
  page.on('pageerror', (e) => onLog?.(`[pageerror] ${e.message}`));
  await page.goto(`${url}?headless`);
  await page.waitForFunction(() => !!window.trompe, null, { timeout: 60000 });
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  onLog?.(`renderer: ${gpu}`);
  return page;
}
