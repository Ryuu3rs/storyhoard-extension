import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createBoundedRequestClient, type FetchFunction, type SourceContext } from "@amr/source-sdk"
import {
    fanfoxFamilySiteConfigs,
    madaraSiteConfigs,
    mangaStreamSiteConfigs,
    mangareadConfig,
    sourceAdapters
} from "@amr/sources"
import { createAdapterFromProfile, parseProfile, PROFILE_FORMAT_2 } from "@amr/source-engine"
import { describe, expect, it } from "vitest"
import { OFFICIAL_SITES_DEFAULT, isOfficialHost } from "../official-sources"
import { buildSeed, buildSeedEntries } from "./seed-spec"

const here = dirname(fileURLToPath(import.meta.url))
const seedPath = join(here, "..", "..", "..", "..", "packages", "sources", "migration-seed.json")
const committed = JSON.parse(readFileSync(seedPath, "utf8")) as { seedVersion: number; profiles: unknown[] }

// Webtoons identifies a series by a QUERY parameter, which a path-only profile cannot capture. It is
// a Tier-1 official source that stays bundled and is never seeded, so it has no parity corpus.
const PARITY_EXEMPT = new Set(["webtoons"])

describe("committed migration-seed.json", () => {
    it("is exactly what the generator produces (no drift)", () => {
        expect(committed).toEqual(JSON.parse(JSON.stringify(buildSeed())))
    })

    it("has exactly one format-2 profile per currently-shipped source, id === sourceId", () => {
        const ids = committed.profiles.map(p => (p as { id: string }).id)
        expect(ids).toEqual(sourceAdapters.map(a => a.manifest.id))
        expect(new Set(ids).size).toBe(ids.length)
        for (const profile of committed.profiles) {
            expect((profile as { profileFormat: number }).profileFormat).toBe(PROFILE_FORMAT_2)
        }
    })

    it("every profile parses through the real schema AND createAdapterFromProfile accepts it", () => {
        for (const raw of committed.profiles) {
            const parsed = parseProfile(raw)
            expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
            if (!parsed.ok) continue
            const adapter = createAdapterFromProfile(parsed.profile)
            expect(adapter.manifest.id).toBe(parsed.profile.id)
            expect(adapter.manifest.domains).toEqual(parsed.profile.domains)
        }
    })

    it("carries no circumvention surface: no token/nonce/signature/header/cookie fields anywhere", () => {
        const forbidden = /token|nonce|signature|secret|cookie|header|authorization|drm|challenge/i
        const walk = (value: unknown, path: string): void => {
            if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`))
            else if (value && typeof value === "object") {
                for (const [key, v] of Object.entries(value)) {
                    expect(forbidden.test(key), `forbidden key "${path}.${key}"`).toBe(false)
                    walk(v, `${path}.${key}`)
                }
            }
        }
        walk(committed, "seed")
        for (const raw of committed.profiles) {
            expect((raw as { pages?: unknown }).pages, "format-2 seed never extracts page images").toBeUndefined()
        }
    })

    it("recognition-only profiles (no list) are limited to sources that cannot be listed by a plain fetch", () => {
        const noList = committed.profiles
            .filter(p => (p as { list?: unknown }).list === undefined)
            .map(p => (p as { id: string }).id)
            .sort()
        // Anything outside the structurally-scoped families (Madara rows, MangaStream rows) is
        // tracking-only until a validated list pattern exists for it.
        const listed = new Set([
            mangareadConfig.id,
            ...madaraSiteConfigs.map(c => c.id),
            ...mangaStreamSiteConfigs.map(c => c.id)
        ])
        for (const id of noList) expect(listed.has(id), `${id} unexpectedly has no list`).toBe(false)
        for (const id of listed) expect(noList.includes(id), `${id} should carry a list`).toBe(false)
    })
})

describe("Tier-1 official sources", () => {
    it("are identifiable from the seed's own domains (the register routine skips these)", () => {
        const tier1 = committed.profiles
            .map(p => p as { id: string; domains: string[] })
            .filter(p => p.domains.some(d => isOfficialHost(d, OFFICIAL_SITES_DEFAULT)))
            .map(p => p.id)
            .sort()
        expect(tier1).toEqual(["mangadex", "webtoons"])
    })
})

describe("recognition parity with the real bundled adapters", () => {
    for (const entry of buildSeedEntries()) {
        const id = entry.profile.id
        if (PARITY_EXEMPT.has(id)) continue
        it(`${id}: match() and parseMangaUrl() agree with the bundled adapter over the corpus`, () => {
            const real = sourceAdapters.find(a => a.manifest.id === id)!
            const generic = createAdapterFromProfile(entry.profile)
            expect(entry.samples.length).toBeGreaterThan(0)
            for (const sample of entry.samples) {
                const url = new URL(sample.url)
                expect(generic.match(url), `match ${sample.url}`).toBe(real.match(url))
                expect(generic.parseMangaUrl?.(url)?.sourceMangaId ?? null, `parse ${sample.url}`).toBe(sample.mangaId)
                // Where the real adapter names a series for the URL, it must be the same one.
                const realParsed = real.parseMangaUrl?.(url)
                if (realParsed) expect(realParsed.sourceMangaId, `real parse ${sample.url}`).toBe(sample.mangaId)
            }
        })
    }

    it("every family config row is covered by a generated corpus", () => {
        const covered = new Set(buildSeedEntries().map(e => e.profile.id))
        for (const c of [
            mangareadConfig,
            ...madaraSiteConfigs,
            ...mangaStreamSiteConfigs,
            ...fanfoxFamilySiteConfigs
        ]) {
            expect(covered.has(c.id), c.id).toBe(true)
        }
    })
})

function listContext(origin: string, html: string): SourceContext {
    const fetch: FetchFunction = async () => ({ ok: true, status: 200, text: async () => html })
    return {
        request: createBoundedRequestClient({
            fetch,
            allowedOrigins: [origin],
            maxRequests: 10,
            maxResponseBytes: 1_000_000,
            timeoutMs: 1000
        }),
        now: () => 1_700_000_000_000,
        logger: { debug: () => undefined, warn: () => undefined }
    }
}

function mangaStub(sourceId: string, slug: string, url: string) {
    return {
        manga: {
            id: `${sourceId}:manga:${slug}`,
            title: "Test",
            normalizedTitle: "test",
            authors: [],
            status: "unknown" as const,
            addedAt: 0,
            updatedAt: 0
        },
        sourceId,
        sourceMangaId: slug,
        url
    }
}

describe("list parity (Madara + MangaStream family rows)", () => {
    for (const config of [mangareadConfig, ...madaraSiteConfigs]) {
        const entry = buildSeedEntries().find(e => e.profile.id === config.id)!
        it(`${config.id}: profile lists the same chapters as the bundled Madara adapter`, async () => {
            const prefix = config.chapterPrefix ?? "chapter"
            const mangaPath = config.mangaPath ?? "manga"
            const row = (n: number) =>
                `<li class="wp-manga-chapter  "><a href="${config.origin}/${mangaPath}/some-title/${prefix}-${n}/">Chapter ${n}</a></li>`
            // The popular-widget row carries another series' chapter but NOT the chapter-list row class.
            const html = `<ul class="popular"><li class="popular-item"><a href="${config.origin}/${mangaPath}/other/${prefix}-99/">Other 99</a></li></ul>
<ul class="main version-chap">${[3, 2, 1].map(row).join("\n")}</ul>`
            const real = sourceAdapters.find(a => a.manifest.id === config.id)!
            const generic = createAdapterFromProfile(entry.profile)
            const manga = mangaStub(config.id, "some-title", `${config.origin}/${mangaPath}/some-title/`)
            const ctx = () => listContext(config.origin, html)
            const expected = await real.listChapters!({ manga }, ctx())
            const actual = await generic.listChapters!({ manga }, ctx())
            const key = (c: { url: string; sortKey: number }) => `${c.sortKey}|${c.url}`
            expect(actual.map(key).sort()).toEqual(expected.map(key).sort())
            expect(actual).toHaveLength(3)
        })
    }

    for (const config of mangaStreamSiteConfigs) {
        const entry = buildSeedEntries().find(e => e.profile.id === config.id)!
        it(`${config.id}: profile lists the same chapters as the bundled MangaStream adapter`, async () => {
            const mangaPath = config.mangaPath ?? "manga"
            const hierarchical = config.chapterFormat === "hierarchical"
            const href = (n: number) =>
                hierarchical
                    ? `${config.origin}/${mangaPath}/some-title/${n}/`
                    : `${config.origin}/some-title-chapter-${n}/`
            const rows = [3, 2, 1]
                .map(n => `<li data-num="${n}"><a href="${href(n)}"><span>Chapter ${n}</span></a></li>`)
                .join("\n")
            const html = `<div class="latest"><a href="${config.origin}/other-series-chapter-77/">Other 77</a></div>
<div id="chapterlist"><ul>${rows}</ul></div>`
            const real = sourceAdapters.find(a => a.manifest.id === config.id)!
            const generic = createAdapterFromProfile(entry.profile)
            const manga = mangaStub(config.id, "some-title", `${config.origin}/${mangaPath}/some-title/`)
            const expected = await real.listChapters!({ manga }, listContext(config.origin, html))
            const actual = await generic.listChapters!({ manga }, listContext(config.origin, html))
            const key = (c: { url: string; sortKey: number }) => `${c.sortKey}|${c.url}`
            expect(actual.map(key).sort()).toEqual(expected.map(key).sort())
            expect(actual).toHaveLength(3)
        })
    }
})
