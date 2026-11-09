import { SourceError } from "@amr/source-sdk"
import { createBackup, db, putVersions, restoreTitleFromBackup } from "../database"
import { getCachedOfficialSites } from "../official-sources"
import {
    linkAnotherSite,
    listTitleSources,
    listUnresolvedTitles,
    previewChange,
    removeTitleVersion,
    setPreferredSource
} from "../title-sources"
import { ownSourceVersion } from "../work-versions"
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

    "title:source-undo": async request => {
        await restoreTitleFromBackup(request.backupId, request.mangaId)
        return { restored: true }
    }
}
