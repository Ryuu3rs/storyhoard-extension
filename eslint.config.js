import globals from "globals"
import svelte from "eslint-plugin-svelte"
import tseslint from "typescript-eslint"

// Globals injected by WXT auto-imports and the WebExtension runtime.
const wxtGlobals = {
    browser: "readonly",
    chrome: "readonly",
    defineBackground: "readonly",
    defineContentScript: "readonly",
    defineUnlistedScript: "readonly"
}

export default tseslint.config(
    {
        ignores: [
            "**/.output/**",
            "**/.wxt/**",
            "**/node_modules/**",
            "**/dist/**",
            "archive/**",
            ".claude/**",
            ".site-lab/**",
            "tooling/source-probe/output/**",
            "tooling/source-health/output/**",
            "tooling/browser-tests/runner/**"
        ]
    },
    ...tseslint.configs.recommended,
    {
        files: ["**/*.{ts,mts,js,mjs}"],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node, ...wxtGlobals }
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "no-empty": ["error", { allowEmptyCatch: true }]
        }
    },
    ...svelte.configs["flat/recommended"],
    {
        files: ["**/*.svelte"],
        languageOptions: {
            parserOptions: { parser: tseslint.parser },
            globals: { ...globals.browser, ...wxtGlobals }
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "off",
            // Opinionated style/perf rules - not correctness. Revisit later:
            // each-key would mean keying ~18 list blocks; the SvelteSet/SvelteMap
            // rule conflicts with our reassign-to-trigger-reactivity pattern.
            "svelte/require-each-key": "off",
            "svelte/prefer-svelte-reactivity": "off"
        }
    },
    {
        // Closes the "sortKey 0" bug class permanently: a sortKey must never fall
        // back to a literal 0 (0 sorts before Chapter 1 AND clobbers reading
        // progress). It must come from parseChapterNumber / assignListSortKeys /
        // UNNUMBERED_SORT_KEY instead. See packages/source-sdk/src/chapter-numbering.ts.
        files: ["packages/sources/src/**/*.ts"],
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector:
                        "Property[key.name='sortKey'] > LogicalExpression:matches([operator='||'], [operator='??']) > Literal[value=0]",
                    message:
                        "sortKey must come from parseChapterNumber/assignListSortKeys/UNNUMBERED_SORT_KEY, never a 0 fallback"
                }
            ]
        }
    },
    {
        // Closes the "falsy-0 merge" bug class: `Math.max(a ?? 0, b ?? 0) || undefined`
        // maps two genuine chapter-0 values (Math.max(0,0) === 0, then `0 || undefined`)
        // to undefined, silently wiping real chapter-0 reading progress on
        // relink/merge/import. Merge chapter NUMBERS with maxDefined() instead.
        files: ["apps/extension/src/**/*.ts"],
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector:
                        "LogicalExpression[operator='||'] > CallExpression.left[callee.object.name='Math'][callee.property.name='max']",
                    message: "Math.max(...) || undefined wipes a genuine chapter 0; use maxDefined"
                }
            ]
        }
    },
    {
        // Handlers must never write Dexie directly - every mutation goes through a
        // named function in database.ts (multi-step writes get a db.transaction there,
        // single writes get a thin wrapper). This keeps every write in one place where
        // its transaction scope and MV3-restart atomicity can be reasoned about, and
        // stops the untransacted multi-step-write bug class from creeping back in.
        // (The Math.max guard is repeated here because a file's `no-restricted-syntax`
        // config does not merge across blocks - the later, more-specific block wins.)
        files: ["apps/extension/src/handlers/**/*.ts"],
        ignores: ["apps/extension/src/handlers/**/*.test.ts"],
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector:
                        "LogicalExpression[operator='||'] > CallExpression.left[callee.object.name='Math'][callee.property.name='max']",
                    message: "Math.max(...) || undefined wipes a genuine chapter 0; use maxDefined"
                },
                {
                    selector:
                        "CallExpression[callee.object.object.name='db'][callee.property.name=/^(put|bulkPut|add|bulkAdd|update|delete|bulkDelete|modify|clear)$/]",
                    message:
                        "Handlers must not write Dexie directly; move the write into a named function in database.ts"
                }
            ]
        }
    }
)
