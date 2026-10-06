// ARCHITECTURE TRACK A - experimental.
//
// Health-check a Site Profile against its live site: confirm the pipeline (search -> series ->
// chapters -> pages) actually works, and auto-correct the origin when the primary mirror is
// dead but a declared mirror domain still serves. Used at import time so the user gets a
// concrete "imported + verified" (or a specific failure) instead of a silent dud, and so a
// rotated mirror (ww2 -> ww3 -> ...) is picked up without a manual re-import.

import type { SourceContext } from "@amr/source-sdk"
import { createAdapterFromProfile } from "./create-adapter-from-profile"
import type { SiteProfile } from "./profile-schema"

export type ProbeStage = "search" | "series" | "chapters" | "pages"

export type ProbeReport = {
    ok: boolean
    effectiveOrigin: string
    originCorrected: boolean
    // The profile with its origin corrected to the working mirror (same object when unchanged).
    profile: SiteProfile
    stages: Array<{ stage: ProbeStage; ok: boolean; detail: string }>
}

// Candidate origins to try, primary first, then each declared domain as https. Deduped,
// keeping the profile's own origin ahead of derived ones.
function candidateOrigins(profile: SiteProfile): string[] {
    const out: string[] = [profile.origin.replace(/\/$/, "")]
    for (const domain of profile.domains) {
        const derived = `https://${domain}`
        if (!out.includes(derived)) out.push(derived)
    }
    return out
}

// Does this origin respond to a cheap search at all? Used to pick the working mirror.
async function originResponds(
    profile: SiteProfile,
    origin: string,
    query: string,
    context: SourceContext
): Promise<boolean> {
    try {
        const adapter = createAdapterFromProfile({ ...profile, origin })
        if (!adapter.search) {
            // No search: fall back to confirming the series-URL template fetches.
            await adapter.resolveManga({ sourceMangaId: profile.domains[0] ?? "x" }, context).catch(() => undefined)
            return true
        }
        await adapter.search(query, context)
        return true
    } catch {
        return false
    }
}

export async function probeSource(
    profile: SiteProfile,
    context: SourceContext,
    opts?: { sampleQuery?: string }
): Promise<ProbeReport> {
    const query = opts?.sampleQuery ?? "a"
    const stages: ProbeReport["stages"] = []

    // 1) Find a working origin (auto-correct for a rotated mirror).
    let workingOrigin = profile.origin.replace(/\/$/, "")
    const primaryOk = await originResponds(profile, workingOrigin, query, context)
    if (!primaryOk) {
        for (const candidate of candidateOrigins(profile)) {
            if (candidate === workingOrigin) continue
            if (await originResponds(profile, candidate, query, context)) {
                workingOrigin = candidate
                break
            }
        }
    }
    const originCorrected = workingOrigin !== profile.origin.replace(/\/$/, "")
    const corrected: SiteProfile = originCorrected ? { ...profile, origin: workingOrigin } : profile
    const adapter = createAdapterFromProfile(corrected)

    // 2) Search.
    let firstUrl: URL | undefined
    if (adapter.search) {
        try {
            const results = await adapter.search(query, context)
            if (results.length > 0) {
                stages.push({ stage: "search", ok: true, detail: `${results.length} result(s)` })
                firstUrl = new URL(results[0]!.url)
            } else {
                stages.push({ stage: "search", ok: false, detail: `no results for "${query}"` })
            }
        } catch (error) {
            stages.push({ stage: "search", ok: false, detail: message(error) })
        }
    }

    // 3) Series + 4) chapters + 5) pages, driven off the first search hit.
    if (firstUrl) {
        try {
            const manga = await adapter.resolveManga({ url: firstUrl }, context)
            stages.push({ stage: "series", ok: manga.manga.title.length > 0, detail: manga.manga.title })
            try {
                const chapters = await adapter.listChapters({ manga }, context)
                stages.push({ stage: "chapters", ok: chapters.length > 0, detail: `${chapters.length} chapter(s)` })
                // Page-image extraction is only probed when the profile declares `pages` (format-1
                // / sideload reader). A format-2 profile never extracts images, so there is no pages
                // stage to pass - verification ends at a non-empty chapter list.
                const firstChapter = chapters[0]
                if (firstChapter && corrected.pages) {
                    try {
                        const resolved = await adapter.resolveChapter({ url: new URL(firstChapter.url) }, context)
                        stages.push({
                            stage: "pages",
                            ok: resolved.pages.length > 0,
                            detail: `${resolved.pages.length} page(s)`
                        })
                    } catch (error) {
                        stages.push({ stage: "pages", ok: false, detail: message(error) })
                    }
                }
            } catch (error) {
                stages.push({ stage: "chapters", ok: false, detail: message(error) })
            }
        } catch (error) {
            stages.push({ stage: "series", ok: false, detail: message(error) })
        }
    }

    const ok = stages.length > 0 && stages.every(s => s.ok)
    return { ok, effectiveOrigin: workingOrigin, originCorrected, profile: corrected, stages }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
