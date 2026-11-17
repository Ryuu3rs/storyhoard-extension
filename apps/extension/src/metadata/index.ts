import { isPublicCoverUrl } from "../background/covers"
import { anilistProvider } from "./anilist"
import { vpsProvider } from "./vps"
import type { MangaStatus, MetadataProvider, MetadataQuery, MetadataResult } from "./provider"

export * from "./provider"

const STATUSES = new Set<unknown>(["unknown", "ongoing", "completed", "hiatus", "cancelled"])
const positiveInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined
const stringList = (v: unknown): string[] | undefined => {
    const kept = Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : []
    return kept.length > 0 ? kept : undefined
}

// A provider answer is network input (the VPS body is cast, not parsed), so only well-typed fields
// are passed on, and only a cover address the cover fetch would accept.
export function sanitizeMetadataResult(raw: MetadataResult): MetadataResult {
    const r = raw as Record<string, unknown>
    const anilistId = positiveInt(r["anilistId"])
    const malId = positiveInt(r["malId"])
    const genres = stringList(r["genres"])
    const tags = stringList(r["tags"])
    return {
        ...(anilistId !== undefined ? { anilistId } : {}),
        ...(malId !== undefined ? { malId } : {}),
        ...(typeof r["title"] === "string" ? { title: r["title"] } : {}),
        ...(STATUSES.has(r["status"]) ? { status: r["status"] as MangaStatus } : {}),
        ...(isPublicCoverUrl(r["coverUrl"]) ? { coverUrl: r["coverUrl"] } : {}),
        ...(genres ? { genres } : {}),
        ...(tags ? { tags } : {}),
        ...(typeof r["isOneshot"] === "boolean" ? { isOneshot: r["isOneshot"] } : {})
    }
}

// Ordered provider chain. The self-hosted VPS catalog goes first once its service is
// deployed and origin configured (it caches AniList lookups across all users);
// AniList direct is the fallback and, until the VPS exists, the only provider. First
// non-null result wins.
const providers: MetadataProvider[] = import.meta.env.VITE_METADATA_API_ORIGIN
    ? [vpsProvider, anilistProvider]
    : [anilistProvider]

export async function resolveMetadata(query: MetadataQuery): Promise<MetadataResult | null> {
    const title = query.title?.trim()
    if (!title) return null
    for (const provider of providers) {
        try {
            const result = await provider.resolve(query)
            if (result) return sanitizeMetadataResult(result)
        } catch {
            // Provider unavailable - fall through to the next.
        }
    }
    return null
}

// Chain-level title-variant lookup for the source resolver: iterates the SAME
// provider chain in order (VPS catalog first, AniList fallback) and returns the
// first provider's non-empty variant list. A provider without the method, or one
// that returns [] or throws, is skipped so the chain falls through to the next.
// Returns [] when no provider yields variants.
export async function resolveSearchTitles(anilistId: number): Promise<string[]> {
    for (const provider of providers) {
        if (!provider.resolveSearchTitles) continue
        try {
            const titles = await provider.resolveSearchTitles(anilistId)
            if (titles.length > 0) return titles
        } catch {
            // Provider unavailable - fall through to the next.
        }
    }
    return []
}
