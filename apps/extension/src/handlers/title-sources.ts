import { SourceError } from "@amr/source-sdk"
import { createBackup, db, putVersions, restoreTitleFromBackup } from "../database"
import { cancelFind, findAvailability, findTitlesOnSource } from "../find-on-source"
import { diag } from "../diag-log"
import { buildAdoptRequest, hasNoSite } from "../find-source"
import { getCachedOfficialSites } from "../official-sources"
import { getSourceById } from "../sources"
import {
    linkAnotherSite,
    listTitleSources,
    listUnresolvedTitles,
    previewChange,
    removeTitleVersion,
    setPreferredSource
} from "../title-sources"
import { ownSourceVersion, recordMirrorVersions } from "../work-versions"
import { libraryHandlers } from "./library"
import type { HandlerMap } from "../background/handler-types"

export const titleSourcesHandlers: HandlerMap = {
    "title:sources": async request => listTitleSources(request.mangaId),
    "title:unresolved": async () => listUnresolvedTitles(),
    "title:source-prefer": async request => setPreferredSource(request.mangaId, request.sourceId),
    "title:source-remove": async request => removeTitleVersion(request.mangaId, request.versionId),
    "title:source-link": async request => linkAnotherSite(request.mangaId, request.url),
    "title:source-preview": async request =>
        previewChange(request.mangaId, {
            url: request.url,
            sourceId: request.sourceId,
            sourceMangaId: request.sourceMangaId,
            mangaUrl: request.mangaUrl
        }),

    // Every source change goes through library:switch, which keeps the title's id and maps the read chapter
    // by number. A restore point is taken first so the change can be undone, and the source being left is
    // kept as a known version of the title.
    "title:source-change": async (request, ctx) => {
        const existing = await db.manga.get(request.mangaId)
        if (!existing) throw new SourceError("not-found", "That title is not in your library")
        const backupId = await createBackup("pre-source-change")
        await putVersions([ownSourceVersion(existing, await getCachedOfficialSites(), Date.now())])
        const result = await libraryHandlers["library:switch"]!(
            {
                type: "library:switch",
                mangaId: request.mangaId,
                sourceId: request.sourceId,
                sourceMangaId: request.sourceMangaId,
                mangaUrl: request.mangaUrl,
                ...(request.allowTabFallback !== undefined ? { allowTabFallback: request.allowTabFallback } : {})
            },
            ctx
        )
        return { backupId, result }
    },

    "source:find-availability": async request => ({ availability: await findAvailability(request.sourceId) }),
    "source:find-titles": async request =>
        findTitlesOnSource(request.sourceId, request.after !== undefined ? { after: request.after } : {}),
    "source:find-cancel": async request => {
        cancelFind(request.sourceId)
        return { cancelled: true }
    },

    // Titles the user picked from a "Find my titles here" run. A title already on a site gets this one as another
    // source; a title on no site yet is moved onto it, as Fix-it's "Find on my other sites" does.
    "source:add-found": async (request, ctx) => {
        const adapter = getSourceById(request.sourceId)
        if (!adapter) throw new SourceError("not-found", "That site is not available")
        let added = 0
        let failed = 0
        for (const pick of request.picks) {
            try {
                const url = new URL(pick.url)
                const manga = await db.manga.get(pick.mangaId)
                if (!manga || url.protocol !== "https:" || adapter.match(url) !== "manga") {
                    diag.warn("find-titles", "a found title was not added", {
                        reason: manga ? "not a series page of this site" : "title no longer in the library"
                    })
                    failed += 1
                    continue
                }
                const candidate = { sourceId: request.sourceId, sourceMangaId: pick.sourceMangaId, url: pick.url }
                if (hasNoSite(manga)) {
                    await libraryHandlers["library:switch"]!(buildAdoptRequest(pick.mangaId, candidate, false), ctx)
                } else {
                    await recordMirrorVersions(pick.mangaId, [candidate])
                }
                added += 1
            } catch (error) {
                diag.warn("find-titles", "adding a found title failed", { error })
                failed += 1
            }
        }
        return { added, failed }
    },

    "title:source-undo": async request => {
        await restoreTitleFromBackup(request.backupId, request.mangaId)
        return { restored: true }
    }
}
