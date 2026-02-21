// eslint.config.mjs — ESLint flat config (v9+)
//
// Zones:
//   1. src/server/**/*.ts  — TypeScript with type-aware rules
//   2. scripts/**/*.ts     — TypeScript (relaxed)
//   3. scripts/**/*.mjs    — ES modules
//   4. test/**/*.ts         — TypeScript (relaxed)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    // ── Global ignores ──────────────────────────────────────
    {
        ignores: [
            'dist/',
            'node_modules/',
            'coverage/',
            'legacy/',
            'data/',
            'web/',
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
            'no-useless-assignment': 'off', // false positives on $${idx++} query-builder pattern
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
            'no-useless-assignment': 'off', // false positives on $${idx++} pattern
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
