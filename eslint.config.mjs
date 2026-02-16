// eslint.config.mjs — ESLint flat config (v9+)
//
// Two zones:
//   1. src/server/**/*.ts  — TypeScript with type-aware rules
//   2. src/client/**/*.js  — Vanilla JS with import-map validation

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import importmapPlugin from './eslint-plugin-importmap.mjs';

export default tseslint.config(
    // ── Global ignores ──────────────────────────────────────
    {
        ignores: [
            'dist/',
            'node_modules/',
            'coverage/',
            'legacy/',
            'data/',
            '**/*.d.ts',
        ],
    },

    // ── Server: TypeScript (type-aware) ─────────────────────
    {
        files: ['src/server/**/*.ts'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended,
        ],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // Relax rules that conflict with existing patterns
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'off', // pino handles logging, but server scripts use console
        },
    },

    // ── Client: Vanilla JS with import map ──────────────────
    {
        files: ['src/client/**/*.js'],
        extends: [js.configs.recommended],
        plugins: {
            importmap: importmapPlugin,
        },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
            },
        },
        rules: {
            // Import map enforcement — catches bare specifiers that
            // don't match any entry in the index.html import map
            'importmap/no-unresolved-importmap': 'error',

            // Practical quality rules
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-undef': 'off', // browser globals via globals.browser; import map aliases aren't resolvable
            'eqeqeq': ['error', 'allow-null'],  // == null is the idiomatic null/undefined check
            'no-var': 'error',
            'prefer-const': 'warn',
        },
    },

    // ── Scripts (TypeScript) ──────────────────────────────────
    {
        files: ['scripts/**/*.ts'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended,
        ],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
            globals: {
                ...globals.node,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-require-imports': 'off',
        },
    },

    // ── Scripts (JS/MJS) & config files ─────────────────────
    {
        files: ['scripts/**/*.mjs', '*.mjs'],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        },
    },

    // ── Test files ──────────────────────────────────────────
    {
        files: ['test/**/*.ts'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended,
        ],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
            globals: {
                ...globals.node,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
