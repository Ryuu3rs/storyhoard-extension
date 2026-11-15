import { defineConfig } from "vitest/config"

// Unit tests exercise every adapter still kept in the repository, so they run with the local bundled
// scope. A shipped build bundles only the official sources (packages/sources/src/build-scope.ts).
export default defineConfig({ test: { env: { VITE_BUNDLED: "1" } } })
