// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules that carry architectural weight.
 *
 * The hard guarantees — `core` never sees `three`, `Math.random` never appears
 * in `core`, no GLSL escape hatch anywhere — are also enforced by
 * `pnpm check:deps`, which needs no dependencies and runs before install. These
 * rules exist so the same mistakes are caught in the editor, a second before
 * the gate catches them.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'artifacts/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: false },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // ---------------------------------------------------------------- core ----
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*'],
              message:
                '@planet/core must stay renderer-free: the simulation has to run headless in ' +
                'Node. Put anything that needs three in @planet/render.',
            },
            {
              group: ['@planet/field', '@planet/render', '@planet/explorer'],
              message: '@planet/core is the bottom of the stack and imports no other package.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() is banned in @planet/core. Every random number goes through hash.ts, ' +
            'or the same seed stops producing the same world.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: '@planet/core must run headless in Node.' },
        { name: 'document', message: '@planet/core must run headless in Node.' },
      ],
    },
  },

  // ------------------------------------------------------- shader policy ----
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name=/^(Raw)?ShaderMaterial$/]",
          message: 'Shaders are TSL only. No ShaderMaterial.',
        },
        {
          selector: "MemberExpression[property.name='onBeforeCompile']",
          message: 'Shaders are TSL only. No onBeforeCompile.',
        },
        {
          selector: "NewExpression[callee.name='EffectComposer']",
          message: 'Post-processing goes through the TSL node stack, not EffectComposer.',
        },
        {
          selector: "NewExpression[callee.name='WebGLRenderer']",
          message: 'The renderer is three/webgpu. A WebGL fallback is not supported.',
        },
      ],
    },
  },

  // The core rules above are the stricter set; re-state the shader policy for
  // core so the later block does not replace them.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() is banned in @planet/core. Every random number goes through hash.ts, ' +
            'or the same seed stops producing the same world.',
        },
        {
          selector: "NewExpression[callee.name=/^(Raw)?ShaderMaterial$/]",
          message: 'Shaders are TSL only. No ShaderMaterial.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- tests ---
  {
    files: ['**/test/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Node scripts are plain JavaScript and run outside the TS project.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        GPUTexture: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
