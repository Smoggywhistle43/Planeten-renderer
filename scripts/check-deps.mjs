#!/usr/bin/env node
/**
 * Architecture gate. Runs as `pnpm check:deps`.
 *
 * Enforces the rules from the stage-01 handoff that a type checker cannot see:
 *
 *   1. `@planet/core` imports nothing from `three` — not directly, not through
 *      another workspace package. `core` has to stay usable headless in Node.
 *   2. `Math.random()` is banned in `core`. All randomness goes through `hash.ts`.
 *   3. The package layering holds: core <- field <- render <- explorer.
 *      No upward imports, no imports of undeclared workspace packages.
 *   4. No GLSL escape hatches anywhere: `ShaderMaterial`, `RawShaderMaterial`,
 *      `onBeforeCompile`, `EffectComposer`, `WebGLRenderer`.
 *
 * Deliberately dependency-free so it also runs before `pnpm install`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Package layering. A package may only import packages listed for it. */
const ALLOWED_WORKSPACE_DEPS = {
  '@planet/core': [],
  '@planet/field': ['@planet/core'],
  '@planet/render': ['@planet/core', '@planet/field'],
  '@planet/explorer': ['@planet/core', '@planet/field', '@planet/render'],
};

/** Packages that must never see `three`, transitively included. */
const THREE_FREE = ['@planet/core'];

const PACKAGE_DIRS = ['packages/core', 'packages/field', 'packages/render', 'apps/explorer'];

const BANNED_GLOBAL = [
  { re: /\bnew\s+ShaderMaterial\b|\bTHREE\.ShaderMaterial\b|\bShaderMaterial\b/, msg: 'ShaderMaterial is banned — shaders are TSL only' },
  { re: /\bRawShaderMaterial\b/, msg: 'RawShaderMaterial is banned — shaders are TSL only' },
  { re: /\bonBeforeCompile\b/, msg: 'onBeforeCompile is banned — shaders are TSL only' },
  { re: /\bEffectComposer\b/, msg: 'EffectComposer is banned — post-processing goes through the TSL node stack' },
  { re: /\bnew\s+WebGLRenderer\b|\bTHREE\.WebGLRenderer\b/, msg: 'WebGLRenderer is banned — the renderer is three/webgpu' },
  { re: /\bglsl\s*`/, msg: 'GLSL template literal found — shaders are TSL only' },
];

const errors = [];
const checked = { files: 0, packages: 0 };

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Remove comments and string/template bodies so scans don't trip over prose. */
function strip(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const IMPORT_RES = [
  /\bimport\s+(?:[^'"()]*?\bfrom\s*)?["']([^"']+)["']/g,
  /\bexport\s+[^'"()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function importsOf(source) {
  const specifiers = new Set();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) specifiers.add(m[1]);
  }
  return [...specifiers];
}

function isThree(spec) {
  return spec === 'three' || spec.startsWith('three/');
}

function isWorkspace(spec) {
  return spec.startsWith('@planet/');
}

function workspaceRoot(spec) {
  const parts = spec.split('/');
  return `${parts[0]}/${parts[1]}`;
}

// ---------------------------------------------------------------- scan ------

/** packageName -> { dir, imports:Set<string>, manifest } */
const packages = new Map();

for (const dir of PACKAGE_DIRS) {
  const absDir = join(ROOT, dir);
  const manifest = JSON.parse(readFileSync(join(absDir, 'package.json'), 'utf8'));
  const name = manifest.name;
  checked.packages++;

  const imports = new Set();
  for (const file of walk(absDir)) {
    checked.files++;
    const rel = relative(ROOT, file).split(sep).join('/');
    const raw = readFileSync(file, 'utf8');
    const code = strip(raw);

    for (const spec of importsOf(code)) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      imports.add(spec);
    }

    for (const { re, msg } of BANNED_GLOBAL) {
      if (re.test(code)) errors.push(`${rel}: ${msg}`);
    }

    if (THREE_FREE.includes(name) && /\bMath\s*\.\s*random\b/.test(code)) {
      errors.push(`${rel}: Math.random() is banned in ${name} — use hash.ts`);
    }
  }

  packages.set(name, { dir, imports, manifest });
}

// ------------------------------------------------------- rule: layering -----

for (const [name, pkg] of packages) {
  const allowed = ALLOWED_WORKSPACE_DEPS[name];
  if (!allowed) {
    errors.push(`${pkg.dir}: package ${name} has no entry in ALLOWED_WORKSPACE_DEPS`);
    continue;
  }
  for (const spec of pkg.imports) {
    if (!isWorkspace(spec)) continue;
    const dep = workspaceRoot(spec);
    if (dep === name) continue;
    if (!allowed.includes(dep)) {
      errors.push(`${pkg.dir}: ${name} imports ${dep}, which the layering does not allow (allowed: ${allowed.join(', ') || 'none'})`);
    }
    const declared = { ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies };
    if (!(dep in declared)) {
      errors.push(`${pkg.dir}: ${name} imports ${dep} but does not declare it in package.json`);
    }
  }
  for (const spec of pkg.imports) {
    if (isWorkspace(spec) || isThree(spec)) continue;
    const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const declared = {
      ...pkg.manifest.dependencies,
      ...pkg.manifest.devDependencies,
      ...pkg.manifest.peerDependencies,
    };
    const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const rootDeclared = { ...rootManifest.dependencies, ...rootManifest.devDependencies };
    if (!(bare in declared) && !(bare in rootDeclared)) {
      errors.push(`${pkg.dir}: ${name} imports "${spec}" but neither the package nor the root declares ${bare}`);
    }
  }
}

// ----------------------------------------------- rule: core is three-free ---

/** Transitive closure of workspace imports. */
function transitiveWorkspaceDeps(name, seen = new Set()) {
  const pkg = packages.get(name);
  if (!pkg) return seen;
  for (const spec of pkg.imports) {
    if (!isWorkspace(spec)) continue;
    const dep = workspaceRoot(spec);
    if (dep === name || seen.has(dep)) continue;
    seen.add(dep);
    transitiveWorkspaceDeps(dep, seen);
  }
  return seen;
}

for (const name of THREE_FREE) {
  const pkg = packages.get(name);
  if (!pkg) {
    errors.push(`check:deps is configured for ${name}, which does not exist`);
    continue;
  }

  for (const spec of pkg.imports) {
    if (isThree(spec)) errors.push(`${pkg.dir}: ${name} imports "${spec}" — ${name} must stay renderer-free`);
  }

  const manifestDeps = {
    ...pkg.manifest.dependencies,
    ...pkg.manifest.devDependencies,
    ...pkg.manifest.peerDependencies,
  };
  if ('three' in manifestDeps) {
    errors.push(`${pkg.dir}/package.json: ${name} declares a dependency on three`);
  }

  for (const dep of transitiveWorkspaceDeps(name)) {
    const depPkg = packages.get(dep);
    if (!depPkg) continue;
    for (const spec of depPkg.imports) {
      if (isThree(spec)) {
        errors.push(`${name} -> ${dep}: ${dep} imports "${spec}", so ${name} would pull in three transitively`);
      }
    }
  }
}

// ------------------------------------------------------------- report -------

if (errors.length > 0) {
  console.error(`check:deps FAILED — ${errors.length} violation(s)\n`);
  for (const e of errors) console.error(`  x ${e}`);
  console.error('');
  process.exit(1);
}

console.log(`check:deps OK`);
console.log(`  packages scanned : ${checked.packages}`);
console.log(`  files scanned    : ${checked.files}`);
console.log(`  @planet/core     : free of three (direct + transitive), free of Math.random`);
console.log(`  layering         : core <- field <- render <- explorer`);
console.log(`  shader policy    : no ShaderMaterial / onBeforeCompile / EffectComposer / WebGLRenderer`);
