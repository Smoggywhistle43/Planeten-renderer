/**
 * Opt-in compatibility shim for a Chromium older than three r185 expects.
 *
 * three sets `swizzle: 'rgba'` — the identity swizzle — on every
 * `GPUTextureViewDescriptor`. Chromium 141 implements an earlier draft in which
 * that key had to be a dictionary and rejects the string, which makes every
 * render pass throw. Newer Chromium and current Safari accept it.
 *
 * This runs only when `PLANET_LEGACY_SWIZZLE=1`, and only in the test browser.
 * The engine is not modified: dropping an identity swizzle changes nothing
 * about what is drawn. See STATE.md, offene Punkte.
 */

declare const GPUTexture: { prototype: { createView: (descriptor?: object) => unknown } } | undefined;

if (import.meta.env?.['VITE_PLANET_LEGACY_SWIZZLE'] === '1' && typeof GPUTexture !== 'undefined') {
  const original = GPUTexture.prototype.createView;
  let stripping = false;

  const without = (descriptor: Record<string, unknown>): Record<string, unknown> => {
    const copy: Record<string, unknown> = {};
    for (const key in descriptor) {
      if (key === 'swizzle') continue;
      copy[key] = descriptor[key];
    }
    return copy;
  };

  GPUTexture.prototype.createView = function createView(
    this: unknown,
    descriptor?: Record<string, unknown>,
  ): unknown {
    if (descriptor && stripping && 'swizzle' in descriptor) {
      return original.call(this, without(descriptor));
    }
    try {
      return original.call(this, descriptor);
    } catch (error) {
      if (descriptor && 'swizzle' in descriptor && /swizzle/i.test(String(error))) {
        stripping = true;
        return original.call(this, without(descriptor));
      }
      throw error;
    }
  } as typeof original;
}
