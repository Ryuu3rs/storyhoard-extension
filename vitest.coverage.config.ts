import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        include: ["packages/*/src/**/*.test.ts", "apps/extension/src/**/*.test.ts"],
        exclude: ["**/node_modules/**", "**/archive/**", "**/tooling/**"],
        environment: "node",
        env: { VITE_BUNDLED: "1" },
        coverage: {
            provider: "v8",
            include: ["packages/*/src/**/*.ts", "apps/extension/src/**/*.ts"],
            exclude: ["**/*.test.ts", "**/node_modules/**", "**/__fixtures__/**", "**/*.d.ts"]
        }
    }
})
