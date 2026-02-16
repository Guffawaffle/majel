/**
 * eslint-plugin-importmap — Validates bare specifiers against the import map.
 *
 * Browser import maps turn bare specifiers (e.g. 'api/auth.js') into relative
 * URLs. But ESLint/Node don't see the import map, so a typo like 'utls/x.js'
 * slips past every other check until it fails at runtime in the browser.
 *
 * This plugin reads the allowed prefixes from the import map in index.html
 * and flags any bare specifier that doesn't match.
 */

// ── Known import map entries (from src/client/index.html) ───
// Keep in sync with the <script type="importmap"> block.
const IMPORT_MAP_KEYS = [
    'api/',
    'views/',
    'components/',
    'utils/',
    'router',
    'app',
];

function isRelative(specifier) {
    return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

function isNodeBuiltinOrNpm(specifier) {
    return specifier.startsWith('node:');
}

function matchesImportMap(specifier) {
    return IMPORT_MAP_KEYS.some(key =>
        key.endsWith('/')
            ? specifier.startsWith(key)
            : specifier === key
    );
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Bare import specifiers must match an entry in the browser import map',
        },
        messages: {
            unknownBareSpecifier:
                "Bare specifier '{{specifier}}' doesn't match any import map entry. " +
                'Known prefixes: {{known}}. Use a relative path or update the import map in index.html.',
        },
        schema: [],
    },
    create(context) {
        function check(node) {
            const specifier = node.source?.value;
            if (!specifier) return;
            if (isRelative(specifier)) return;
            if (isNodeBuiltinOrNpm(specifier)) return;
            if (matchesImportMap(specifier)) return;

            context.report({
                node: node.source,
                messageId: 'unknownBareSpecifier',
                data: {
                    specifier,
                    known: IMPORT_MAP_KEYS.join(', '),
                },
            });
        }

        return {
            ImportDeclaration: check,
            ExportNamedDeclaration: check,
            ExportAllDeclaration: check,
        };
    },
};

export default {
    rules: {
        'no-unresolved-importmap': rule,
    },
};
