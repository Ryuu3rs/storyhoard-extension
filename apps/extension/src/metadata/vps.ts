import type { MetadataProvider, MetadataQuery, MetadataResult } from "./provider"

// Self-hosted VPS metadata catalog. Base origin is injected at build time from
// apps/extension/.env (gitignored) as VITE_METADATA_API_ORIGIN - never hardcoded.
// The value is a full origin and may carry the host-permission wildcard suffix
// (e.g. https://catalog.example.com/*); strip a trailing "/*" or "/" before
// building request URLs. When unset, this provider is inert and resolve() returns
// null so the chain falls straight through to AniList.
const REQUEST_TIMEOUT_MS = 5000

// Read lazily (not module-scope) so tests can stub the env var per case; the
// origin is build-inlined by Vite in production so there is no runtime cost.
function metadataOrigin(): string | undefined {
    const raw = import.meta.env.VITE_METADATA_API_ORIGIN as string | undefined
    const trimmed = raw?.trim()
    if (!trimmed) return undefined
    return trimmed.replace(/\/\*$/, "").replace(/\/$/, "")
}

// A MetadataResult carries at least one of these catalog fields; a body without
// any of them (e.g. { result: null }) is a miss, not a hit.
function isMetadataResult(body: unknown): body is MetadataResult {
    if (!body || typeof body !== "object") return false
    const b = body as Record<string, unknown>
    return "anilistId" in b || "malId" in b || "status" in b || "coverUrl" in b || "genres" in b
}

async function getJson(url: string): Promise<unknown | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const res = await fetch(url, {
            headers: { Accept: "application/json" },
            credentials: "omit",
            signal: controller.signal
        })
        if (!res.ok) return null
        return await res.json()
    } catch {
        return null
    } finally {
        clearTimeout(timeout)
    }
}

// VPS catalog metadata provider. Primary in the chain when its origin is
// configured. Returns null on no match, missing config, or any network/parse/
// timeout failure so the caller can fall through to AniList cleanly. Never throws.
export const vpsProvider: MetadataProvider = {
    name: "vps",

    async resolve(q: MetadataQuery): Promise<MetadataResult | null> {
        const origin = metadataOrigin()
        if (!origin) return null
        const title = q.title.trim()
        if (!title) return null
        const params = new URLSearchParams({ title })
        if (q.sourceId) params.set("sourceId", q.sourceId)
        if (q.sourceMangaId) params.set("sourceMangaId", q.sourceMangaId)
        const body = await getJson(`${origin}/metadata/resolve?${params.toString()}`)
        return isMetadataResult(body) ? body : null
    },

    async getByAnilistId(id: number): Promise<MetadataResult | null> {
        const origin = metadataOrigin()
        if (!origin) return null
        const body = await getJson(`${origin}/metadata/by-anilist/${encodeURIComponent(String(id))}`)
        return isMetadataResult(body) ? body : null
    }

    // resolveSearchTitles is intentionally not implemented yet: the chain skips a
    // provider that lacks it, so title-variant lookups fall through to AniList. Add
    // it here once the catalog serves per-id title variants, to keep them VPS-first.
}
