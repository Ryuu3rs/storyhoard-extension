import { beforeEach, describe, expect, it, vi } from "vitest"

let granted: string[] = []
let required: string[] = []
const covers = (grant: string, origin: string): boolean => {
    if (grant === origin) return true
    const host = /^[^:]+:\/\/\*\.([^/]+)\/\*$/.exec(grant)?.[1]
    return host !== undefined && new URL(origin.replace("/*", "/")).hostname.endsWith(`.${host}`)
}
vi.stubGlobal("browser", {
    permissions: {
        contains: vi.fn(async ({ origins }: { origins: string[] }) =>
            origins.every(origin => granted.some(grant => covers(grant, origin)))
        ),
        getAll: vi.fn(async () => ({ origins: granted, permissions: [] }))
    },
    runtime: { getManifest: () => ({ host_permissions: required }) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } }
})

const { holdsChosenAccess } = await import("./site-approvals")

beforeEach(() => {
    granted = []
    required = []
})

describe("holdsChosenAccess", () => {
    it("does not treat a site as chosen just because a narrower wildcard grant covers it", async () => {
        granted = ["https://*.com/*"]
        expect(await holdsChosenAccess(["https://victim.com/*"])).toBe(false)
    })

    it("counts a site the user granted by its own pattern", async () => {
        granted = ["https://*.com/*", "https://picked.com/*"]
        expect(await holdsChosenAccess(["https://picked.com/*"])).toBe(true)
    })

    it("is not made strict by the manifest's own required wildcard grants", async () => {
        required = ["*://*.cdn.example/*"]
        granted = ["*://*.cdn.example/*"]
        expect(await holdsChosenAccess(["https://img.cdn.example/*"])).toBe(true)
    })
})
