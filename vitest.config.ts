/// <reference types="@vitest/browser/providers/playwright" />
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, one command.
 *
 * `node` — everything that must stay runnable headless: @planet/core in full,
 *          plus the renderer logic in @planet/render that needs no GPU
 *          (quadtree, LOD scheduling, camera maths, tile geometry).
 * `gpu`  — Vitest browser mode against real WebGPU. The field determinism test
 *          lives here because there is exactly one implementation of the noise
 *          and it is TSL, so the only honest way to sample it is to run it.
 *
 * `pnpm test` runs both.
 *   PLANET_SKIP_GPU_TESTS=1   run the node project only.
 *   PLANET_CHROMIUM_PATH=...  use a Chromium that Playwright did not install;
 *                             a preinstalled one under PLAYWRIGHT_BROWSERS_PATH
 *                             is found on its own.
 *
 * On a fresh machine the browser project needs `pnpm exec playwright install
 * chromium` once. On a machine without a hardware GPU the SwiftShader flags
 * below give Chromium a software WebGPU adapter — correct, just slow.
 */
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
function findChromium() {
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

const skipGpu = process.env['PLANET_SKIP_GPU_TESTS'] === '1';
const chromiumPath = findChromium();
/**
 * Chromium older than about 145 rejects the identity `swizzle` three r185 puts
 * on every texture view. Set this to run the GPU tests there anyway; see
 * STATE.md, offene Punkte.
 */
const legacySwizzle = process.env['PLANET_LEGACY_SWIZZLE'] === '1';

const CHROMIUM_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--disable-dev-shm-usage',
  '--no-sandbox',
];

export default defineConfig({
  define: {
    'import.meta.env.VITE_PLANET_LEGACY_SWIZZLE': JSON.stringify(legacySwizzle ? '1' : '0'),
  },
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/core/test/**/*.test.ts',
            'packages/render/test/**/*.test.ts',
            'packages/field/test/**/*.node.test.ts',
          ],
          // `*.gpu.test.ts` matches the pattern above but belongs to the other
          // project; without this it would run twice, once without a device.
          exclude: ['**/*.gpu.test.ts', '**/node_modules/**'],
        },
      },
      ...(skipGpu
        ? []
        : [
            {
              test: {
                name: 'gpu',
                include: [
                  'packages/field/test/**/*.gpu.test.ts',
                  'packages/render/test/**/*.gpu.test.ts',
                ],
                setupFiles: ['./test/setup-legacy-swizzle.ts'],
                testTimeout: 180_000,
                hookTimeout: 180_000,
                browser: {
                  enabled: true,
                  provider: 'playwright' as const,
                  headless: true,
                  screenshotFailures: false,
                  instances: [
                    {
                      browser: 'chromium' as const,
                      launch: {
                        args: CHROMIUM_ARGS,
                        ...(chromiumPath ? { executablePath: chromiumPath } : {}),
                      },
                    },
                  ],
                },
              },
            },
          ]),
    ],
  },
});
