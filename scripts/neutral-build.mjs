import { spawnSync } from "node:child_process"

const browser = process.argv[2]
const args = ["run", browser === "firefox" ? "build:firefox" : "build"]
const result = spawnSync("npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, VITE_NO_BUNDLED: "1" }
})
process.exit(result.status ?? 1)
