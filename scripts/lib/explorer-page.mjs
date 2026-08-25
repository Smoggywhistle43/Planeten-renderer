/**
 * Shared plumbing for the scripts that drive the explorer in a headless
 * browser: build it, serve it, launch Chromium, wait for it to come up.
 *
 * Used by `acceptance.mjs`, which gates a stage, and by `portrait.mjs`, which
 * just takes pictures.
 */

import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createReadStream, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
export const DIST = join(ROOT, 'apps/explorer/dist');
export const ARTIFACTS = join(ROOT, 'artifacts');

/**
 * Chromium without a GPU falls back to SwiftShader, which is a correct WebGPU
 * implementation and a slow one. Fine for pictures and for correctness; not
 * for judging frame rate.
 */
export const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--disable-dev-shm-usage',
  '--no-sandbox',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Compatibility shim for an old Chromium, applied to the PAGE only — the engine
 * is not modified.
 *
 * three r185 sets `swizzle: 'rgba'` (the identity swizzle) on every
 * GPUTextureViewDescriptor. Chromium 141 implements an earlier draft where that
 * key had to be a dictionary, and rejects the string outright. Newer Chromium
 * and current Safari accept it, so this wrapper detects the rejection once and
 * only then drops the key, which is a no-op because the value is the identity.
 *
 * If it ever fires on a current browser, that is a finding, not a workaround.
 */
export const SWIZZLE_SHIM = () => {
  if (typeof GPUTexture === 'undefined') return;
  const original = GPUTexture.prototype.createView;
  let stripping = false;
  const without = (descriptor) => {
    const copy = {};
    for (const key in descriptor) {
      if (key === 'swizzle') continue;
      copy[key] = descriptor[key];
    }
    return copy;
  };
  GPUTexture.prototype.createView = function createView(descriptor) {
    if (descriptor && stripping && 'swizzle' in descriptor) {
      return original.call(this, without(descriptor));
    }
    try {
      return original.call(this, descriptor);
    } catch (error) {
      if (descriptor && 'swizzle' in descriptor && /swizzle/i.test(String(error))) {
        stripping = true;
        window.__swizzleShimApplied = true;
        return original.call(this, without(descriptor));
      }
      throw error;
    }
  };
};

export function buildExplorer(log = console.log) {
  log('building explorer …');
  const result = spawnSync('pnpm', ['--filter', '@planet/explorer', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('explorer build failed');
}

export function serveDist() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(DIST, path);
    if (path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    if (!file.startsWith(DIST) || !existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

/**
 * Launch Chromium and open the explorer, waiting until its harness is live.
 *
 * Returns the browser, the page and a `close()` that tears down both the
 * browser and the static server.
 *
 * `query` is appended to the URL — `?relief=0&surface=0` asks the explorer for
 * the plain reference body, which is what a measurement wants and a picture
 * does not.
 */
export async function openExplorer({ viewport, headless = true, log = console.log, query = '' }) {
  const { server, port } = await serveDist();
  log(`serving ${DIST} on 127.0.0.1:${port}`);

  const executablePath = findChromium();
  const browser = await chromium.launch({
    headless,
    args: CHROMIUM_ARGS,
    ...(executablePath ? { executablePath } : {}),
  });

  const page = await browser.newPage({ viewport });
  await page.addInitScript(SWIZZLE_SHIM);
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__planet?.ready === true || typeof window.__planetError === 'string',
    { timeout: 180_000 },
  );

  const bootError = await page.evaluate(() => window.__planetError ?? null);
  if (bootError) {
    await browser.close();
    server.close();
    throw new Error(`explorer failed to start:\n${bootError}`);
  }

  return {
    browser,
    page,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/** Hide or show the HUD and the help line. */
export async function setChromeVisible(page, visible) {
  await page.evaluate((v) => {
    for (const id of ['overlay', 'help']) {
      const el = document.getElementById(id);
      if (el) el.style.display = v ? '' : 'none';
    }
  }, visible);
}

/** Run `count` frames in one round trip, pumping the build queue between them. */
export async function stepFrames(page, count, deltaSeconds = 0) {
  await page.evaluate(
    async ([n, dt]) => {
      for (let i = 0; i < n; i++) {
        window.__planet.renderFrame(dt);
        await window.__planet.pump();
      }
    },
    [count, deltaSeconds],
  );
}

/**
 * Where Chromium actually is.
 *
 * `PLANET_CHROMIUM_PATH` wins. Otherwise, if `PLAYWRIGHT_BROWSERS_PATH` points
 * at a shared install, pick the newest `chromium-<build>` directory in it —
 * Playwright looks for a build number matching the version it was compiled
 * against and simply fails when a preinstalled browser carries a different one.
 * Falling back to Playwright's own lookup keeps a normal `playwright install`
 * working untouched.
 */
export function findChromium() {
  const explicit = process.env.PLANET_CHROMIUM_PATH;
  if (explicit) return explicit;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;

  const builds = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .map((name) => ({ name, build: Number(name.slice('chromium-'.length)) }))
    .sort((a, b) => b.build - a.build);

  for (const { name } of builds) {
    const candidate = join(root, name, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Save the canvas to a PNG, reliably.
 *
 * Not `page.screenshot`. That captures whatever the compositor last presented,
 * and a WebGPU canvas is not guaranteed to have presented the frame just
 * rendered — so it returns a stale image, or a black one, at random. It is the
 * same race that made `renderFrame` synchronous: a WebGPU canvas can only be
 * read back in the task that drew it.
 *
 * This renders and copies inside one page evaluation, so there is nothing for
 * the compositor to be late for. Every archived picture goes through it.
 */
export async function captureCanvas(page, path) {
  const url = await page.evaluate(() => {
    window.__planet.renderFrame(0);
    const canvas = document.getElementById('view');
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    off.getContext('2d').drawImage(canvas, 0, 0);
    return off.toDataURL('image/png');
  });
  writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'));
}
